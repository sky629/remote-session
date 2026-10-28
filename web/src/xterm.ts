import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { TerminalFrame } from "#shared/domain";

/** A read-only xterm.js view of one pane at the pane's real size (spec 8.3). Input goes through KeyBar, never xterm. */
export interface TerminalSurface {
  /** full → reset() then write. A width/height change resizes before writing. bytes: base64 → Uint8Array → term.write. */
  apply(frame: TerminalFrame): void;
  /** fit: CSS transform scale = host width / grid width, recomputed by ResizeObserver (rotation). native: 1:1 with horizontal scroll. */
  setScale(mode: "fit" | "native"): void;
  dispose(): void;
}

const FONT_SIZE = 12;

function themeFromTokens(): NonNullable<Terminal["options"]["theme"]> {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string) => css.getPropertyValue(name).trim() || undefined;
  const background = token("--term-bg");
  return { background, foreground: token("--term-fg"), brightBlack: token("--term-dim"), cursor: background, cursorAccent: background };
}

function decode(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Options: disableStdin, scrollback 0, cursorBlink false, theme from the CSS --term-* tokens. */
export function createTerminalSurface(host: HTMLElement): TerminalSurface {
  const sizer = document.createElement("div");
  const stage = document.createElement("div");
  sizer.className = "term-sizer";
  stage.className = "term-stage";
  sizer.append(stage);
  host.append(sizer);

  const term = new Terminal({
    disableStdin: true,
    scrollback: 0,
    cursorBlink: false,
    cursorInactiveStyle: "none",
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono") || "monospace",
    fontSize: FONT_SIZE,
    theme: themeFromTokens(),
  });
  term.open(stage);

  let mode: "fit" | "native" = "fit";
  let frameRequest = 0;

  // The scaled stage takes no layout space, so the sizer is given the scaled grid size explicitly.
  function layout(): void {
    frameRequest = 0;
    const screen = stage.querySelector<HTMLElement>(".xterm-screen");
    if (!screen || screen.offsetWidth === 0) return;
    const gridWidth = screen.offsetWidth;
    const gridHeight = screen.offsetHeight;
    const scale = mode === "fit" ? Math.min(1, host.clientWidth / gridWidth) : 1;
    stage.style.transform = scale === 1 ? "" : `scale(${scale})`;
    sizer.style.width = `${Math.ceil(gridWidth * scale)}px`;
    sizer.style.height = `${Math.ceil(gridHeight * scale)}px`;
  }
  const scheduleLayout = () => {
    if (!frameRequest) frameRequest = requestAnimationFrame(layout);
  };

  const resizeObserver = new ResizeObserver(scheduleLayout);
  resizeObserver.observe(host);
  const colorScheme = matchMedia("(prefers-color-scheme: dark)");
  const onScheme = () => {
    term.options.theme = themeFromTokens();
  };
  colorScheme.addEventListener("change", onScheme);

  return {
    apply(frame) {
      if (frame.width !== term.cols || frame.height !== term.rows) {
        term.resize(frame.width, frame.height);
        scheduleLayout();
      }
      if (frame.full) term.reset();
      term.write(decode(frame.bytes));
    },
    setScale(next) {
      mode = next;
      host.dataset.scale = next;
      scheduleLayout();
    },
    dispose() {
      cancelAnimationFrame(frameRequest);
      resizeObserver.disconnect();
      colorScheme.removeEventListener("change", onScheme);
      term.dispose();
      sizer.remove();
    },
  };
}
