import type { WebSocket } from "ws";
import type { SessionId } from "#shared/domain";
import type { Result } from "#shared/errors";
import { CommandSchema } from "#shared/protocol";
import type { Command, InputCommand, RequestId, ServerMessage } from "#shared/protocol";
import type { Auth, TokenHash } from "#auth";
import { dialogId } from "#claude";
import type { Transcripts } from "#claude";
import type { SessionRegistry } from "#sessions";
import type { SourceTable, TerminalObservation } from "#source";

export interface HubDeps {
  registry: SessionRegistry;
  transcripts: Transcripts;
  sources: SourceTable;
  auth: Pick<Auth, "isTokenLive">;
}

export interface Hub {
  /** Takes an upgraded socket that passed both gates and the Origin check. The first message is always the full list. */
  attach(ws: WebSocket, token: TokenHash): void;
  close(): void;
}

/**
 * One phone connection. Its observations belong to it alone (spec 7: one child process per client and session),
 * so no reference counts exist and a closed socket releases exactly what it opened.
 */
interface Client {
  ws: WebSocket;
  token: TokenHash;
  terminals: Map<SessionId, TerminalObservation>;
  /** Sessions whose frames were dropped under backpressure; resynced when the socket drains. */
  behind: Set<SessionId>;
  /** Heartbeats sent since the last pong. */
  missed: number;
}

/**
 * Input commands seen in the last 2 minutes, across all sockets. A phone that reconnects and resends a requestId
 * gets the stored result and herdr gets nothing (spec 6.6). The promise is stored at once, so an in-flight duplicate
 * waits too. watch and unwatch are not stored: they change only the sending client's state and are idempotent.
 */
type RecentCommands = Map<RequestId, { at: number; result: Promise<Result> }>;

const RECENT_MS = 120_000;
const HEARTBEAT_MS = 15_000;
/** A frame that would queue behind this much unsent data is dropped; a missing delta would corrupt the screen. */
const BACKLOG_BYTES = 2 * 1024 * 1024;
/** The web treats this close code as "logged out" and goes straight to the login screen. */
const LOGGED_OUT = 4401;

/**
 * Demand is derived, never stored: polling and transcript following are on exactly while `clients` is not empty.
 * Chat is pushed for every followed transcript to every client, because Command has no chat subscription.
 */
export function createHub(deps: HubDeps): Hub {
  const clients = new Set<Client>();
  const recent: RecentCommands = new Map();

  function demand(): void {
    const on = clients.size > 0;
    deps.registry.setActive(on);
    deps.transcripts.follow(new Set(on ? deps.registry.current().sessions.flatMap((s) => s.claudeSessionId ?? []) : []));
  }

  function send(c: Client, msg: ServerMessage): void {
    if (c.ws.readyState !== c.ws.OPEN) return;
    if (msg.type === "frame") {
      if (c.ws.bufferedAmount > BACKLOG_BYTES) {
        c.behind.add(msg.sessionId);
        return;
      }
      if (c.behind.delete(msg.sessionId) && !msg.frame.full) {
        c.terminals.get(msg.sessionId)?.resync();
        return;
      }
    }
    c.ws.send(JSON.stringify(msg));
  }

  function broadcast(msg: ServerMessage): void {
    for (const c of clients) send(c, msg);
  }

  /** For a client that fell behind on a screen that then went quiet: no next frame would come to trigger the resync. */
  function catchUp(c: Client): void {
    if (!c.behind.size || c.ws.bufferedAmount > BACKLOG_BYTES) return;
    for (const id of c.behind) c.terminals.get(id)?.resync();
    c.behind.clear();
  }

  function remember(id: RequestId, run: () => Promise<Result>): Promise<Result> {
    let hit = recent.get(id);
    if (!hit) {
      hit = { at: Date.now(), result: run() };
      recent.set(id, hit);
    }
    return hit.result;
  }

  async function onMessage(c: Client, raw: string): Promise<void> {
    if (!deps.auth.isTokenLive(c.token)) return c.ws.close(LOGGED_OUT, "logged_out");
    const parsed = parseCommand(raw);
    if (!parsed.ok) {
      if (parsed.requestId) send(c, { type: "command_result", requestId: parsed.requestId, ok: false, error: "invalid_command" });
      return;
    }
    const cmd = parsed.command;
    const run = () =>
      execute({ terminals: c.terminals, send: (m) => send(c, m) }, cmd, deps).catch((e: unknown): Result => {
        console.error(`command ${cmd.type} failed: ${(e as Error).message}`);
        return { ok: false, error: "internal" };
      });
    const result = await (isInput(cmd) ? remember(cmd.requestId, run) : run());
    send(c, { type: "command_result", requestId: cmd.requestId, ...result });
  }

  const unsubscribe = [
    deps.registry.subscribe((list, diff) => {
      broadcast({ type: "sessions", ...list });
      for (const id of diff.removed) {
        for (const c of clients) {
          c.terminals.get(id)?.close();
          c.terminals.delete(id);
        }
      }
      demand();
    }),
    deps.transcripts.onAppend((cid, events) => {
      for (const s of deps.registry.current().sessions) if (s.claudeSessionId === cid) broadcast({ type: "chat", sessionId: s.id, events });
    }),
  ];

  // iOS drops sockets without a close frame, so a client that misses two pongs in a row is cut.
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const [id, hit] of recent) if (now - hit.at > RECENT_MS) recent.delete(id);
    for (const c of clients) {
      if (!deps.auth.isTokenLive(c.token)) c.ws.close(LOGGED_OUT, "logged_out");
      else if (c.missed >= 2) c.ws.terminate();
      else {
        c.missed++;
        c.ws.ping();
        catchUp(c);
      }
    }
  }, HEARTBEAT_MS);

  return {
    attach(ws, token) {
      const c: Client = { ws, token, terminals: new Map(), behind: new Set(), missed: 0 };
      clients.add(c);
      // The current list goes first; the poll that demand() starts broadcasts the fresh one if anything differs.
      send(c, { type: "sessions", ...deps.registry.current() });
      demand();
      ws.on("message", (data) => void onMessage(c, String(data)));
      ws.on("pong", () => {
        c.missed = 0;
      });
      ws.on("error", () => {});
      ws.on("close", () => {
        for (const o of c.terminals.values()) o.close();
        c.terminals.clear();
        clients.delete(c);
        demand();
      });
    },

    close() {
      clearInterval(heartbeat);
      for (const off of unsubscribe) off();
      for (const c of [...clients]) c.ws.terminate();
      for (const c of clients) for (const o of c.terminals.values()) o.close();
      clients.clear();
      demand();
    },
  };
}

/** The only place commands branch. Never retries a send (spec 7.2; herdr: a timeout does not prove non-delivery). */
export async function execute(
  c: Pick<Client, "terminals"> & { send(msg: ServerMessage): void },
  cmd: Command,
  deps: Pick<HubDeps, "registry" | "sources">,
): Promise<Result> {
  if (cmd.type === "unwatch_terminal") {
    c.terminals.get(cmd.sessionId)?.close();
    c.terminals.delete(cmd.sessionId);
    return { ok: true };
  }
  const session = deps.registry.get(cmd.sessionId);
  if (!session) return { ok: false, error: "pane_closed" };
  if (!session.reachable) return { ok: false, error: "source_unreachable" };
  const source = deps.sources[session.source];
  if (!source) return { ok: false, error: "source_error" };
  const id = session.id;

  switch (cmd.type) {
    case "watch_terminal": {
      const existing = c.terminals.get(id);
      if (existing) {
        existing.resync();
        return { ok: true };
      }
      const observation: TerminalObservation = source.observeTerminal(session, {
        frame: (frame) => c.send({ type: "frame", sessionId: id, frame }),
        status: (state) => {
          // An ended stream leaves the map, so a later watch opens a new one instead of resyncing a dead one.
          if (state === "ended" && c.terminals.get(id) === observation) c.terminals.delete(id);
          c.send({ type: "terminal_status", sessionId: id, state });
        },
      });
      c.terminals.set(id, observation);
      return { ok: true };
    }
    case "keys": {
      if (cmd.guard) {
        // Checked right before the send, so a dialog that changed inside the 1.5 s poll gap is never answered.
        const read = await source.readDialog(session);
        if (!read.ok) return read;
        if (dialogId(read.text) !== cmd.guard.dialogId) return { ok: false, error: "stale_dialog" };
      }
      return source.send(session, cmd);
    }
    case "prompt":
    case "raw_text":
      return source.send(session, cmd);
  }
}

const isInput = (cmd: Command): cmd is InputCommand => cmd.type === "prompt" || cmd.type === "keys" || cmd.type === "raw_text";

/**
 * Stands in for parseCommand from #shared/protocol, whose body is not implemented in shared/ yet. Same signature and
 * contract; replace this with the shared import once that body lands.
 */
function parseCommand(raw: string): { ok: true; command: Command } | { ok: false; requestId: RequestId | null } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, requestId: null };
  }
  const parsed = CommandSchema.safeParse(json);
  if (parsed.success) return { ok: true, command: parsed.data };
  const id = typeof json === "object" && json !== null ? (json as { requestId?: unknown }).requestId : undefined;
  return { ok: false, requestId: typeof id === "string" && /^[\w-]{8,64}$/.test(id) ? (id as RequestId) : null };
}
