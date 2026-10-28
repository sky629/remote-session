import type { WebSocket } from "ws";
import type { SessionId } from "#shared/domain";
import type { Result } from "#shared/errors";
import { parseCommand } from "#shared/protocol";
import type { Command, RequestId, ServerMessage } from "#shared/protocol";
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
}

/**
 * Commands seen in the last 2 minutes, across all sockets. A phone that reconnects and resends a requestId gets the
 * stored result and herdr gets nothing (spec 6.6). The promise is stored at once, so an in-flight duplicate waits too.
 */
type RecentCommands = Map<RequestId, { at: number; result: Promise<Result> }>;

/**
 * Demand is derived, never stored: polling and transcript following are on exactly while `clients` is not empty.
 * Chat is pushed for every followed transcript to every client, because Command has no chat subscription.
 */
export function createHub(deps: HubDeps): Hub {
  // TODO state: clients = new Set<Client>(); recent: RecentCommands = new Map()
  //
  // demand(): on = clients.size > 0; registry.setActive(on)
  //   transcripts.follow(on ? new Set(registry.current().sessions.flatMap(s => s.claudeSessionId ?? [])) : new Set())
  //
  // attach(ws, token): c = { ws, token, terminals: new Map(), behind: new Set() }; clients.add(c); demand()
  //   send(c, { type: "sessions", ...await registry.list() })   (joins the poll demand() started)
  //   ws "message" → !auth.isTokenLive(c.token) → ws.close(4401, "logged_out"), stop
  //     parsed = parseCommand(String(data)); !parsed.ok → answer invalid_command if it had a requestId
  //     hit = recent.get(id) ?? remember(id, execute(c, parsed.command, deps))    (remember stores { at: now, result } and returns it)
  //     send(c, { type: "command_result", requestId: id, ...await hit.result })
  //   ws "close"   → c.terminals.forEach(o => o.close()); clients.delete(c); demand()
  //   heartbeat every 15 s: no pong for 2 rounds → ws.terminate() (iOS drops sockets silently);
  //     !auth.isTokenLive(c.token) → ws.close(4401, "logged_out"); entries of `recent` older than 2 min are dropped
  //
  // registry.subscribe((list, diff) => {
  //   broadcast({ type: "sessions", ...list })
  //   diff.removed.forEach(id => clients.forEach(c => { c.terminals.get(id)?.close(); c.terminals.delete(id) }))
  //   demand()                                       (transcript ids may have changed)
  // })
  // transcripts.onAppend((cid, events) =>
  //   registry.current().sessions.filter(s => s.claudeSessionId === cid).forEach(s => broadcast({ type: "chat", sessionId: s.id, events })))
  //
  // send(c, msg): a frame while c.ws.bufferedAmount > 2 MiB is dropped and c.behind.add(id), because a missing
  //   delta would corrupt the screen; the next frame for id after the buffer drains triggers terminals.get(id).resync()
  throw new Error("not implemented");
}

/** The only place commands branch. Never retries a send (spec 7.2; herdr: a timeout does not prove non-delivery). */
export async function execute(
  c: Pick<Client, "terminals"> & { send(msg: ServerMessage): void },
  cmd: Command,
  deps: Pick<HubDeps, "registry" | "sources">,
): Promise<Result> {
  // TODO
  //   session = deps.registry.get(cmd.sessionId) ?? → pane_closed;  !session.reachable → source_unreachable
  //   source = deps.sources[session.source] ?? → source_error
  //   watch_terminal:   existing = c.terminals.get(id); existing ? existing.resync()     (watch twice → one stream, fresh full frame)
  //                     : c.terminals.set(id, source.observeTerminal(session, {
  //                         frame: f => c.send({ type: "frame", sessionId: id, frame: f }),
  //                         status: state => c.send({ type: "terminal_status", sessionId: id, state }) }))
  //   unwatch_terminal: c.terminals.get(id)?.close(); c.terminals.delete(id)            (unwatch twice → no-op)
  //   keys with guard:  read = await source.readDialog(session); !read.ok → read
  //                     dialogId(read.text) !== cmd.guard.dialogId → stale_dialog       (checked right before the send,
  //                     so a dialog that changed inside the 1.5 s poll gap is never answered with an old choice)
  //   prompt | keys | raw_text: return source.send(session, cmd)
  throw new Error("not implemented");
}
