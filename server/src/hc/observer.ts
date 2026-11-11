import type { ObserverDriver } from "#observer";

export interface HcObserverSpec {
  address: string;
  cols: number;
  rows: number;
}

/**
 * `hc attach --observe <t>` with stdout piped writes the terminal's raw bytes: a full repaint first (soft reset,
 * clear, then the screen), then live output as it happens; it exits 0 when the terminal finishes (measured on
 * 0.1.19). --observe never types or resizes, so the frames are at the terminal's own size, which the spec carries
 * from terminal.list. Each chunk is one frame; only the first is `full`, since the bytes after it continue the
 * same screen.
 */
export function hcDriver(hcBin: string): ObserverDriver<HcObserverSpec> {
  return {
    command: (s) => ({ bin: hcBin, args: ["attach", "--observe", s.address] }),
    reader(s) {
      let seq = 0;
      return (chunk) => [{ seq: ++seq, full: seq === 1, width: s.cols, height: s.rows, bytes: chunk.toString("base64") }];
    },
    same: (a, b) => a.address === b.address && a.cols === b.cols && a.rows === b.rows,
  };
}
