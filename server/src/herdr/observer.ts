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

/** `spec` reads the adapter's latest view, so the size is always the pane's current rect and never the phone's. */
export function createObservation(
  herdrBin: string,
  spec: () => ObserverSpec | null,
  sink: TerminalSink,
  onEnd: () => void,
): HerdrObservation {
  // TODO
  //   state: child | null; running: ObserverSpec | null; closed = false; awaitingFirst = true; delay = 250 (doubles to 5 s)
  //   start(s): spawn without a shell, stdin ignored so the child can neither type nor resize:
  //     spawn(herdrBin, ["--session", s.group, "terminal", "session", "observe", s.terminalId, "--cols", `${s.cols}`, "--rows", `${s.rows}`],
  //           { stdio: ["ignore", "pipe", "pipe"] })
  //     stdout lines → JSON.parse →
  //       "terminal.frame"  → check seq/full/width/height are numbers and bytes a string → sink.frame({ seq, full, width, height, bytes });
  //                           the first frame after a start also sends sink.status("live") and resets delay to 250
  //       "terminal.closed" → same as exit
  //   exit: closed → nothing; else sink.status("restarting"); setTimeout(restart, delay)
  //   restart: s = spec(); s ? start(s) : end()
  //   sync: s = spec(); !s → end(); s differs from running → sink.status("restarting"); kill(); start(s)
  //   resync: kill(); restart()
  //   end: sink.status("ended"); close()      close: closed = true; child?.kill("SIGTERM"); onEnd()   (both idempotent)
  throw new Error("not implemented");
}
