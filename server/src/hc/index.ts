import { existsSync } from "node:fs";
import type { Session } from "#shared/domain";
import type { ErrorCode } from "#shared/errors";
import type { InputCommand } from "#shared/protocol";
import type { SessionSource, SourcePoll } from "#source";
import { createObservation } from "#observer";
import type { Observation } from "#observer";
import { hcDriver } from "./observer.ts";
import type { HcObserverSpec } from "./observer.ts";
import { openHcSocket } from "./socket.ts";
import type { HcMethod, HcSocket } from "./socket.ts";
import { readTerminals, TerminalListError } from "./terminals.ts";
import type { HcView } from "./terminals.ts";

export interface HcOptions {
  hcBin: string;
  socketPath: string;
  callTimeoutMs: number; // 3000
  /** send and keys type only once nobody has typed for about 3 s (hc --skill), so they wait longer for a reply. */
  inputTimeoutMs: number; // 15_000
}

/** This Mac's core. Terminals on machines hc connects to would form further groups by machine name. */
const GROUP = "local";

/**
 * The herdr-core adapter and the only public file of hc/. herdr-core (`hc`) runs every terminal of the Herdr app;
 * this adapter lists the terminals the app shows, types into them and streams their screens. Nothing outside this
 * folder knows hc method names, Terminal fields or hc error kinds.
 */
export function createHcSource(opts: HcOptions): SessionSource {
  let socket: HcSocket | null = null;
  let view: HcView | null = null;
  let reachable = false;
  /** The last failure, logged once until it changes or clears. */
  let problem: string | null = null;
  const observations = new Set<Observation>();

  async function refresh(): Promise<void> {
    socket ??= openHcSocket(opts.socketPath, opts.callTimeoutMs);
    const reply = await socket.call("terminal.list", {});
    let next: string | null = null;
    if (!reply.ok) next = reply.code;
    else {
      try {
        view = readTerminals(GROUP, reply.result);
      } catch (e) {
        if (!(e instanceof TerminalListError)) throw e;
        next = e.message;
      }
    }
    if (next && next !== problem) console.warn(`herdr-core unreachable: ${next}`);
    problem = next;
    reachable = next === null;
  }

  function specFor(address: string): HcObserverSpec | null {
    const size = view?.size.get(address);
    return size ? { address, ...size } : null;
  }

  async function call(method: HcMethod, params: object, timeoutMs: number) {
    if (!socket) return { ok: false as const, code: "unreachable" };
    const reply = await socket.call(method, params, timeoutMs);
    if (!reply.ok) console.warn(`hc ${method} failed: ${reply.code}`);
    return reply;
  }

  return {
    kind: "hc",

    async poll(): Promise<SourcePoll> {
      // No socket file: herdr-core is not installed or not running, so there is no Herdr app group to show.
      if (!existsSync(opts.socketPath)) {
        socket?.close();
        socket = null;
        view = null;
        reachable = false;
        for (const o of observations) o.sync();
        return { groups: [], sessions: [] };
      }
      await refresh();
      for (const o of observations) o.sync();
      const rows = view?.rows ?? [];
      return {
        groups: [{ source: "hc", name: GROUP, reachable }],
        sessions: reachable ? rows : rows.map((r) => ({ ...r, reachable: false as const, status: "unknown" as const })),
      };
    },

    async send(session, input) {
      const req = request(session, input);
      if (!req) return { ok: false, error: "raw_text_unsupported" };
      const reply = await call(req[0], req[1], opts.inputTimeoutMs);
      return reply.ok ? { ok: true } : { ok: false, error: errorFor(reply.code, "send", input.type) };
    },

    async readDialog(session) {
      const reply = await call("terminal.read", { terminal: session.paneId, lines: 0 }, opts.callTimeoutMs);
      if (!reply.ok) return { ok: false, error: errorFor(reply.code, "read") };
      const text = (reply.result as { text?: unknown } | null)?.text;
      return typeof text === "string" ? { ok: true, text } : { ok: false, error: "source_error" };
    },

    observeTerminal(session, sink) {
      const o = createObservation(hcDriver(opts.hcBin), () => specFor(session.paneId), sink, () => observations.delete(o));
      observations.add(o);
      return o;
    },

    async close() {
      for (const o of [...observations]) o.close();
      socket?.close();
      socket = null;
    },
  };
}

/**
 * prompt: terminal.send pastes and presses Enter. keys: terminal.keys by name. raw_text has no hc method of its
 * own (terminal.send always adds Enter), so it goes as one key per character; null when a character cannot be a
 * key name. hc checks every name before it types anything (an unknown name is refused in 0 ms, measured), so a
 * refused text types nothing.
 */
function request(s: Session, input: InputCommand): [HcMethod, object] | null {
  switch (input.type) {
    case "prompt":
      return ["terminal.send", { terminal: s.paneId, text: input.text }];
    case "keys":
      return ["terminal.keys", { terminal: s.paneId, keys: input.keys }];
    case "raw_text": {
      const keys = keysFor(input.text);
      return keys ? ["terminal.keys", { terminal: s.paneId, keys }] : null;
    }
  }
}

/** hc key names (measured on 0.1.19): a printable ASCII character is itself, " " is "space", "A" is "shift+a". */
export function keysFor(text: string): string[] | null {
  if (!/^[\x20-\x7e]*$/.test(text)) return null;
  return [...text].map((ch) => (ch === " " ? "space" : /[A-Z]/.test(ch) ? `shift+${ch.toLowerCase()}` : ch));
}

/** hc's `data.kind` values (`hc schema`). Anything unlisted becomes source_error. */
const HC_ERRORS: Readonly<Record<string, ErrorCode>> = {
  blocked: "agent_blocked", // terminal.send refuses a blocked program unless forced; the phone answers dialogs with keys
  unavailable: "agent_not_ready", // input is pending while a lost program recovers (hc --skill: retry after recovery)
  finished: "pane_closed",
  not_found: "pane_closed",
};

/** A lost reply means "maybe delivered" for a send and "not reachable" for a read, so the call kind decides. */
function errorFor(code: string, call: "send" | "read", input?: InputCommand["type"]): ErrorCode {
  if (code === "unreachable") return "source_unreachable";
  if (code === "no_reply") return call === "send" ? "delivery_unconfirmed" : "source_unreachable";
  if (code === "invalid_params" && input === "raw_text") return "raw_text_unsupported"; // a character hc has no key name for
  return HC_ERRORS[code] ?? "source_error";
}
