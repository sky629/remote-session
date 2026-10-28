import type { ErrorCode } from "#shared/errors";
import type { SessionSource } from "#source";
import { createObservation } from "./observer.ts";
import type { HerdrObservation } from "./observer.ts";
import { readSnapshot, SnapshotError } from "./snapshot.ts";
import type { HerdrView } from "./snapshot.ts";
import { openHerdrSocket } from "./socket.ts";
import type { HerdrSocket } from "./socket.ts";

export interface HerdrOptions {
  herdrBin: string;
  callTimeoutMs: number; // 3000
  relistMs: number; // 60_000, spec 7.2
}

/**
 * The herdr adapter and the only public file of herdr/. It owns the herdr session list, one socket per herdr
 * session, the last view of each, and the live observations. Nothing outside this folder knows herdr method
 * names, snapshot fields, pane rects or herdr error codes.
 */
export function createHerdrSource(opts: HerdrOptions): SessionSource {
  // TODO state
  //   groups: Map<string, { socket: HerdrSocket; view: HerdrView | null; reachable: boolean }>
  //   listedAt = 0; observations = new Set<HerdrObservation>()
  //
  // poll():
  //   if now - listedAt > relistMs: execFile(herdrBin, ["session", "list", "--json"]) → running sessions →
  //     open sockets for new names, close sockets of vanished names (their rows disappear)
  //   per group, in parallel: reply = await socket.call("session.snapshot", {})
  //     ok → view = readSnapshot(name, reply.result.snapshot); reachable = true
  //     failed or SnapshotError → reachable = false; the view is kept
  //   observations.forEach(o => o.sync())        (follows pane resizes; ends streams of closed terminals)
  //   groups: [{ source: "herdr", name, reachable }] for every listed name, empty ones included
  //   sessions: reachable ? view.rows : view?.rows.map(r => ({ ...r, status: "unknown", reachable: false })) ?? []
  //
  // send(session, input): socket of session.group, else source_unreachable
  //   prompt   → "agent.prompt"    { target: paneId, text }                   no wait (spec 7.2)
  //   keys     → session.agent ? "agent.send_keys" { target: paneId, keys } : "pane.send_keys" { pane_id, keys }
  //   raw_text → "pane.send_text"  { pane_id: paneId, text }                   no Enter (spec 5.2)
  //   reply ok → { ok: true }; else { ok: false, error: errorFor(code, "send") }; log code and method, never text
  //
  // readDialog(session): "agent.read" { target: paneId, source: "detection", format: "text", strip_ansi: true } → result.read.text
  //
  // observeTerminal(session, sink):
  //   o = createObservation(herdrBin, () => specFor(session.group, session.terminalId), sink, () => observations.delete(o))
  //   specFor reads groups.get(group)?.view?.size.get(terminalId); observations.add(o); return o
  throw new Error("not implemented");
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
