import type { TerminalFrame } from "#shared/domain";

/** A read-only xterm.js view of one pane at the pane's real size (spec 8.3). Input goes through KeyBar, never xterm. */
export interface TerminalSurface {
  /** full → reset() then write. A width/height change resizes before writing. bytes: base64 → Uint8Array → term.write. */
  apply(frame: TerminalFrame): void;
  /** fit: CSS transform scale = host width / grid width, recomputed by ResizeObserver (rotation). native: 1:1 with horizontal scroll. */
  setScale(mode: "fit" | "native"): void;
  dispose(): void;
}

/** Options: disableStdin, scrollback 0, cursorBlink false, theme from the CSS --term-* tokens. */
export function createTerminalSurface(host: HTMLElement): TerminalSurface {
  throw new Error("not implemented");
}
