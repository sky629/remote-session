import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { Session } from "#shared/domain";
import type { ErrorCode } from "#shared/errors";
import type { InputCommand } from "#shared/protocol";
import type { SessionSource, SourcePoll } from "#source";
import { createObservation } from "./observer.ts";
import type { HerdrObservation, ObserverSpec } from "./observer.ts";
import { readSnapshot, SnapshotError } from "./snapshot.ts";
import type { HerdrView } from "./snapshot.ts";
import { openHerdrSocket } from "./socket.ts";
import type { HerdrMethod, HerdrSocket } from "./socket.ts";

export interface HerdrOptions {
  herdrBin: string;
  callTimeoutMs: number; // 3000
  relistMs: number; // 60_000, spec 7.2
}

/** `herdr session list --json` (measured on 0.9.5): {sessions: [{name, running, socket_path, default, session_dir}]}. */
const SessionListSchema = z.object({
  sessions: z.array(z.object({ name: z.string().min(1), running: z.boolean(), socket_path: z.string().min(1) })),
});

interface Group {
  socketPath: string;
  socket: HerdrSocket;
  view: HerdrView | null;
  reachable: boolean;
  /** The last failure, logged once until it changes or clears. */
  problem: string | null;
}

const execFileP = promisify(execFile);

/**
 * The herdr adapter and the only public file of herdr/. It owns the herdr session list, one socket per herdr
 * session, the last view of each, and the live observations. Nothing outside this folder knows herdr method
 * names, snapshot fields, pane rects or herdr error codes.
 */
export function createHerdrSource(opts: HerdrOptions): SessionSource {
  const groups = new Map<string, Group>();
  const observations = new Set<HerdrObservation>();
  let listedAt = 0;

  async function relist(): Promise<void> {
    let listed: z.infer<typeof SessionListSchema>["sessions"];
    try {
      const { stdout } = await execFileP(opts.herdrBin, ["session", "list", "--json"], { timeout: opts.callTimeoutMs });
      // A "/" in a name would break the session id format, so such a session is not listed.
      listed = SessionListSchema.parse(JSON.parse(stdout)).sessions.filter((s) => s.running && !s.name.includes("/"));
    } catch (e) {
      console.warn(`herdr session list failed: ${(e as Error).message.split("\n")[0]}`);
      return;
    }
    for (const [name, g] of groups) {
      if (listed.some((s) => s.name === name && s.socket_path === g.socketPath)) continue;
      g.socket.close();
      groups.delete(name);
    }
    for (const s of listed) {
      if (!groups.has(s.name)) {
        groups.set(s.name, { socketPath: s.socket_path, socket: openHerdrSocket(s.socket_path, opts.callTimeoutMs), view: null, reachable: false, problem: null });
      }
    }
    listedAt = Date.now();
  }

  async function refresh(name: string, g: Group): Promise<void> {
    const reply = await g.socket.call("session.snapshot", {});
    let problem: string | null = null;
    if (!reply.ok) problem = reply.code;
    else {
      try {
        g.view = readSnapshot(name, (reply.result as { snapshot?: unknown } | null)?.snapshot);
      } catch (e) {
        if (!(e instanceof SnapshotError)) throw e;
        problem = e.message;
      }
    }
    if (problem && problem !== g.problem) console.warn(`herdr session ${name} unreachable: ${problem}`);
    g.problem = problem;
    g.reachable = problem === null;
  }

  function specFor(group: string, terminalId: string): ObserverSpec | null {
    const size = groups.get(group)?.view?.size.get(terminalId);
    return size ? { group, terminalId, ...size } : null;
  }

  async function call(session: Session, method: HerdrMethod, params: object): Promise<{ ok: true; result: unknown } | { ok: false; code: string }> {
    const g = groups.get(session.group);
    if (!g) return { ok: false, code: "unreachable" };
    const reply = await g.socket.call(method, params);
    if (!reply.ok) console.warn(`herdr ${method} failed: ${reply.code}`);
    return reply;
  }

  return {
    kind: "herdr",

    async poll(): Promise<SourcePoll> {
      if (Date.now() - listedAt > opts.relistMs) await relist();
      await Promise.all([...groups].map(([name, g]) => refresh(name, g)));
      for (const o of observations) o.sync();
      return {
        groups: [...groups].map(([name, g]) => ({ source: "herdr", name, reachable: g.reachable })),
        sessions: [...groups.values()].flatMap((g) =>
          g.reachable ? (g.view?.rows ?? []) : (g.view?.rows ?? []).map((r) => ({ ...r, reachable: false as const, status: "unknown" as const })),
        ),
      };
    },

    async send(session, input) {
      const [method, params] = request(session, input);
      const reply = await call(session, method, params);
      return reply.ok ? { ok: true } : { ok: false, error: errorFor(reply.code, "send") };
    },

    async readDialog(session) {
      const reply = await call(session, "agent.read", { target: session.paneId, source: "detection", format: "text", strip_ansi: true });
      if (!reply.ok) return { ok: false, error: errorFor(reply.code, "read") };
      const text = (reply.result as { read?: { text?: unknown } } | null)?.read?.text;
      return typeof text === "string" ? { ok: true, text } : { ok: false, error: "source_error" };
    },

    observeTerminal(session, sink) {
      const o: HerdrObservation = createObservation(opts.herdrBin, () => specFor(session.group, session.terminalId), sink, () => observations.delete(o));
      observations.add(o);
      return o;
    },

    async close() {
      for (const o of [...observations]) o.close();
      for (const g of groups.values()) g.socket.close();
      groups.clear();
    },
  };
}

/** Spec 5.2 and 9: the chat input never writes to the terminal directly; only raw_text uses pane.send_text. */
function request(s: Session, input: InputCommand): [HerdrMethod, object] {
  switch (input.type) {
    case "prompt":
      return ["agent.prompt", { target: s.paneId, text: input.text }]; // no wait (spec 7.2)
    case "keys":
      return s.agent ? ["agent.send_keys", { target: s.paneId, keys: input.keys }] : ["pane.send_keys", { pane_id: s.paneId, keys: input.keys }];
    case "raw_text":
      return ["pane.send_text", { pane_id: s.paneId, text: input.text }]; // no Enter (spec 5.2)
  }
}

/** herdr's own codes. Anything unlisted becomes source_error; add codes seen in the console-test session (spec 12.1). */
const HERDR_ERRORS: Readonly<Record<string, ErrorCode>> = {
  agent_blocked: "agent_blocked",
  agent_not_ready: "agent_not_ready",
  agent_prompt_stalled: "delivery_unconfirmed",
};

/** A lost reply means "maybe delivered" for a send and "not reachable" for a read, so the call kind decides. */
function errorFor(code: string, call: "send" | "read"): ErrorCode {
  if (code === "unreachable") return "source_unreachable";
  if (code === "no_reply") return call === "send" ? "delivery_unconfirmed" : "source_unreachable";
  return HERDR_ERRORS[code] ?? "source_error";
}
