import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { TerminalFrame } from "#shared/domain";
import type { TerminalObservation, TerminalSink } from "#source";

/** What differs between terminal hosts: the child to run for a spec, and how its stdout becomes frames. */
export interface ObserverDriver<S> {
  command(spec: S): { bin: string; args: string[] };
  /** A parser for one child's stdout, called per chunk. "closed" means the host said the terminal is gone. */
  reader(spec: S): (chunk: Buffer) => (TerminalFrame | "closed")[];
  same(a: S, b: S): boolean;
}

/** One stream for one subscriber. Owns at most one observer child at a time. */
export interface Observation extends TerminalObservation {
  /** Called by the adapter after each poll. Restarts the child if the spec changed (pane resized); ends if it is null. */
  sync(): void;
}

const FIRST_DELAY_MS = 250;
const MAX_DELAY_MS = 5000;

/**
 * `spec` reads the adapter's latest view, so the size is always the pane's current one and never the phone's.
 * No sink call happens before this returns. A child that exits, or whose output says "closed", is restarted after
 * 250 ms doubling to 5 s; the first frame resets the delay. The child gets no shell and no stdin, so it can neither
 * type into nor resize the terminal.
 */
export function createObservation<S>(driver: ObserverDriver<S>, spec: () => S | null, sink: TerminalSink, onEnd: () => void): Observation {
  let child: ChildProcess | null = null;
  let running: S | null = null;
  let closed = false;
  let delay = FIRST_DELAY_MS;
  let retry: NodeJS.Timeout | undefined;

  function start(s: S): void {
    running = s;
    let awaitingFirst = true;
    const read = driver.reader(s);
    const { bin, args } = driver.command(s);
    const ch = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    child = ch;
    ch.stdout!.on("data", (chunk: Buffer) => {
      for (const record of read(chunk)) {
        if (child !== ch) return;
        if (record === "closed") return exited(ch);
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
      if (running && driver.same(s, running)) return;
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
