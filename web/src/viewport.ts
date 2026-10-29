import { useEffect } from "preact/hooks";

/** Below this much lost height the visual viewport is not a software keyboard but browser chrome. */
const KEYBOARD_MIN_PX = 120;

/**
 * iOS Safari resizes only the visual viewport when the keyboard opens. #app takes its box from --vvh and --vvt, so the
 * composer and the raw text field stay above the keyboard instead of hiding behind it. data-keyboard drops the home
 * indicator padding, which the keyboard covers anyway.
 */
export function useVisualViewport(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const sync = () => {
      root.style.setProperty("--vvh", `${vv.height}px`);
      root.style.setProperty("--vvt", `${vv.offsetTop}px`);
      root.toggleAttribute("data-keyboard", window.innerHeight - vv.height > KEYBOARD_MIN_PX);
    };
    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
      root.style.removeProperty("--vvh");
      root.style.removeProperty("--vvt");
      root.removeAttribute("data-keyboard");
    };
  }, []);
}
