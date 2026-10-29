import { useEffect, useState } from "preact/hooks";

/** Date.now() refreshed every `intervalMs` while `active`. Components that show elapsed time re-render from it, so no timer writes to the store. */
export function useNow(intervalMs: number, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, active]);
  return now;
}
