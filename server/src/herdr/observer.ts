import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { TerminalFrame } from "#shared/domain";
import type { TerminalObservation, TerminalSink } from "#source";

export interface ObserverSpec {
  group: string;
  terminalId: string;
  cols: number;
  rows: number;
}

/** One stream for one subscriber. Owns at most one `herdr terminal session observe` child at a time. */
export interface HerdrObservation extends TerminalObservation {
  /** Called by the adapter after each poll. Restarts the child if the spec changed (pane resized); ends if it is null. */
  sync(): void;
}

const FIRST_DELAY_MS = 250;
const MAX_DELAY_MS = 5000;

/**
 * `spec` reads the adapter's latest view, so the size is always the pane's current rect and never the phone's.
 * No sink call happens before this returns. A child that exits, or sends terminal.closed (herdr does so for an
 * unknown terminal and then exits 0; measured), is restarted after 250 ms doubling to 5 s; the first frame resets it.
 */
export function createObservation(
  herdrBin: string,
  spec: () => ObserverSpec | null,
  sink: TerminalSink,
  onEnd: () => void,
): HerdrObservation {
  let child: ChildProcess | null = null;
  let running: ObserverSpec | null = null;
  let closed = false;
  let delay = FIRST_DELAY_MS;
  let retry: NodeJS.Timeout | undefined;

  function start(s: ObserverSpec): void {
    running = s;
    let awaitingFirst = true;
    let rest = Buffer.alloc(0);
    // No shell, and stdin ignored: the observer can neither type into nor resize the terminal.
    const ch = spawn(
      herdrBin,
      ["--session", s.group, "terminal", "session", "observe", s.terminalId, "--cols", `${s.cols}`, "--rows", `${s.rows}`],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    child = ch;
    ch.stdout!.on("data", (chunk: Buffer) => {
      rest = Buffer.concat([rest, chunk]);
      for (let nl = rest.indexOf(0x0a); nl >= 0 && child === ch; nl = rest.indexOf(0x0a)) {
        const record = readRecord(rest.subarray(0, nl).toString("utf8"));
        rest = rest.subarray(nl + 1);
        if (record === "closed") return exited(ch);
        if (!record) continue;
        if (awaitingFirst) {
          awaitingFirst = false;
          delay = FIRST_DELAY_MS;
          sink.status("live");
        }
        sink.frame(record);
      }
    });
    ch.stderr!.resume();
    ch.on("error", () => exited(ch));
    ch.on("close", () => exited(ch));
  }

  function exited(ch: ChildProcess): void {
    if (child !== ch) return;
    child = null;
    ch.kill("SIGTERM");
    sink.status("restarting");
    retry = setTimeout(restart, delay);
    delay = Math.min(delay * 2, MAX_DELAY_MS);
  }

  function restart(): void {
    const s = spec();
    if (s) start(s);
    else end();
  }

  function stop(): void {
    clearTimeout(retry);
    const ch = child;
    child = null;
    ch?.kill("SIGTERM");
  }

  function end(): void {
    if (closed) return;
    sink.status("ended");
    close();
  }

  function close(): void {
    if (closed) return;
    closed = true;
    stop();
    onEnd();
  }

  const initial = spec();
  if (initial) start(initial);
  else queueMicrotask(end);

  return {
    sync() {
      if (closed) return;
      const s = spec();
      if (!s) return end();
      if (running && sameSpec(s, running)) return;
      sink.status("restarting");
      stop();
      start(s);
    },
    resync() {
      if (closed) return;
      stop();
      restart();
    },
    close,
  };
}

const sameSpec = (a: ObserverSpec, b: ObserverSpec): boolean =>
  a.group === b.group && a.terminalId === b.terminalId && a.cols === b.cols && a.rows === b.rows;

/** The boundary check on herdr's output: a frame, the end marker, or null for anything else. */
function readRecord(line: string): TerminalFrame | "closed" | null {
  let r: unknown;
  try {
    r = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof r !== "object" || r === null) return null;
  const { type, seq, full, width, height, bytes } = r as Record<string, unknown>;
  if (type === "terminal.closed") return "closed";
  if (type !== "terminal.frame") return null;
  if (typeof seq !== "number" || typeof full !== "boolean" || typeof width !== "number" || typeof height !== "number" || typeof bytes !== "string") return null;
  return { seq, full, width, height, bytes };
}
