import { watch } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import type { ChatEvent, ClaudeSessionId } from "#shared/domain";
import type { Result } from "#shared/errors";

import { lineToEvents, mayBeChatLine } from "./records.ts";

export { blockedDialog, dialogId } from "./blocked.ts";

/**
 * Claude transcripts on this Mac, keyed by Claude session id. One window per file serves both paging and
 * following, so an HTTP page and a WS push can never disagree about where the file was read.
 */
export interface Transcripts {
  /**
   * Finds `<root>/*\/<id>.jsonl` (spec 4.4: never computed from cwd); the newest wins when several match, and a
   * path whose realpath leaves root is ignored (spec 10). Hits are cached while the file exists; misses search
   * again after 10 s. Never rejects.
   */
  locate(id: ClaudeSessionId): Promise<string | null>;
  /**
   * Events strictly older than `before` (the newest when null), oldest first, at most `limit`.
   * The window first reads what was appended, then grows backward until it holds `before` plus `limit` older
   * events, or reaches the file start.
   * No file → no_transcript. `before` absent from the whole file → stale_cursor (the pane moved to another transcript).
   */
  page(id: ClaudeSessionId, before: string | null, limit: number): Promise<Result<{ events: ChatEvent[] }>>;
  /** The desired set of followed transcripts. Adds watchers for new ids, closes and forgets the rest. Idempotent. */
  follow(ids: ReadonlySet<ClaudeSessionId>): void;
  /** Events appended to a followed file, in file order, each event id exactly once. */
  onAppend(listener: (id: ClaudeSessionId, events: ChatEvent[]) => void): () => void;
}

/**
 * Invariants:
 *   [low, high) is fully parsed; low and high are line starts; low === 0 means the file start is reached.
 *   events are in file order and their ids are in `seen`.
 *   At most one forward and one backward read run at a time per window.
 *   Lines are split at byte 0x0A before decoding; 0x0A never occurs inside a UTF-8 sequence.
 *   A replaced file (new inode, or smaller than high) gets a new window object; reads on the old one stop.
 */
interface TranscriptWindow {
  path: string;
  ino: number;
  events: ChatEvent[];
  seen: Set<string>;
  low: number;
  high: number;
  watcher: { close(): void } | null;
  forward: Promise<void> | null;
  backward: Promise<void> | null;
  dirty: boolean;
}

const BLOCK = 256 * 1024;
const MISS_RETRY_MS = 10_000;
/** fs.watch can miss changes on macOS, so a periodic rescan backs it up. */
const RESCAN_MS = 5_000;

export function createTranscripts(root: string): Transcripts {
  const located = new Map<ClaudeSessionId, { path: string | null; at: number }>();
  const windows = new Map<ClaudeSessionId, TranscriptWindow>();
  const opening = new Map<ClaudeSessionId, Promise<TranscriptWindow | null>>();
  const followed = new Set<ClaudeSessionId>();
  const listeners = new Set<(id: ClaudeSessionId, events: ChatEvent[]) => void>();

  async function locate(id: ClaudeSessionId): Promise<string | null> {
    const hit = located.get(id);
    if (hit?.path && (await isFile(hit.path))) return hit.path;
    if (hit && !hit.path && Date.now() - hit.at < MISS_RETRY_MS) return null;
    const path = await search(id);
    located.set(id, { path, at: Date.now() });
    return path;
  }

  async function search(id: ClaudeSessionId): Promise<string | null> {
    try {
      const base = await realpath(root);
      const found = await Promise.all(
        (await readdir(root)).map(async (dir) => {
          try {
            const real = await realpath(join(root, dir, `${id}.jsonl`));
            const st = await stat(real);
            return real.startsWith(base + sep) && st.isFile() ? { path: real, mtime: st.mtimeMs } : null;
          } catch {
            return null;
          }
        }),
      );
      return found.reduce<{ path: string; mtime: number } | null>((a, b) => (b && (!a || b.mtime > a.mtime) ? b : a), null)?.path ?? null;
    } catch {
      return null;
    }
  }

  async function openWindow(id: ClaudeSessionId): Promise<TranscriptWindow | null> {
    const path = await locate(id);
    if (!path) return null;
    return withFile(path, async (fh): Promise<TranscriptWindow> => {
      const st = await fh.stat();
      const start = await lastLineStart(fh, st.size);
      return { path, ino: st.ino, events: [], seen: new Set(), low: start, high: start, watcher: null, forward: null, backward: null, dirty: false };
    }).catch(() => null);
  }

  function windowFor(id: ClaudeSessionId): Promise<TranscriptWindow | null> {
    const w = windows.get(id);
    if (w) return Promise.resolve(w);
    let pending = opening.get(id);
    if (!pending) {
      pending = openWindow(id).then((opened) => {
        opening.delete(id);
        if (opened) windows.set(id, opened);
        return opened;
      });
      opening.set(id, pending);
    }
    return pending;
  }

  function readBackward(w: TranscriptWindow): Promise<void> {
    w.backward ??= withFile(w.path, async (fh) => {
      for (let size = BLOCK; ; size *= 2) {
        const start = Math.max(0, w.low - size);
        const buf = await readAt(fh, start, w.low);
        // buf ends with the 0x0A before low; the first other 0x0A ends a line that began before `start`.
        const skip = start === 0 ? 0 : buf.subarray(0, buf.length - 1).indexOf(0x0a) + 1;
        if (skip === 0 && start > 0) continue;
        const fresh = unseen(w, parse(buf.subarray(skip)));
        w.events = [...fresh, ...w.events];
        w.low = start + skip;
        return;
      }
    }).finally(() => {
      w.backward = null;
    });
    return w.backward;
  }

  function readForward(id: ClaudeSessionId, w: TranscriptWindow): Promise<void> {
    if (w.forward) {
      w.dirty = true;
      return w.forward;
    }
    w.forward = (async () => {
      do {
        w.dirty = false;
        await forwardOnce(id, w);
      } while (w.dirty && windows.get(id) === w);
    })().finally(() => {
      w.forward = null;
    });
    return w.forward;
  }

  async function forwardOnce(id: ClaudeSessionId, w: TranscriptWindow): Promise<void> {
    if (windows.get(id) !== w) return;
    const replaced = await withFile(w.path, async (fh) => {
      const st = await fh.stat();
      if (st.ino !== w.ino || st.size < w.high) return true;
      const buf = await readAt(fh, w.high, st.size);
      const end = buf.lastIndexOf(0x0a) + 1;
      const fresh = unseen(w, parse(buf.subarray(0, end)));
      w.events.push(...fresh);
      w.high += end;
      if (fresh.length) for (const l of listeners) l(id, fresh);
      return false;
    }).catch(() => false); // a vanished file is retried by the rescan
    if (replaced) await replaceWindow(id, w);
  }

  async function replaceWindow(id: ClaudeSessionId, old: TranscriptWindow): Promise<void> {
    old.watcher?.close();
    old.watcher = null;
    const fresh = await openWindow(id);
    if (windows.get(id) !== old) return;
    if (!fresh) {
      windows.delete(id);
      return;
    }
    windows.set(id, fresh);
    if (followed.has(id)) attachWatcher(id, fresh);
  }

  function attachWatcher(id: ClaudeSessionId, w: TranscriptWindow): void {
    if (w.watcher) return;
    let fsWatcher: ReturnType<typeof watch> | null = null;
    try {
      fsWatcher = watch(w.path, () => void readForward(id, w));
      fsWatcher.on("error", () => {});
    } catch {
      // The rescan still follows the file.
    }
    const timer = setInterval(() => void readForward(id, w), RESCAN_MS).unref();
    w.watcher = {
      close() {
        fsWatcher?.close();
        clearInterval(timer);
      },
    };
  }

  async function startFollowing(id: ClaudeSessionId): Promise<void> {
    const w = await windowFor(id);
    if (!w || !followed.has(id) || windows.get(id) !== w) return;
    attachWatcher(id, w);
    await readForward(id, w);
  }

  return {
    locate,

    async page(id, before, limit) {
      const opened = await windowFor(id);
      if (!opened) return { ok: false, error: "no_transcript" };
      try {
        await readForward(id, opened);
        const w = windows.get(id) ?? opened;
        for (;;) {
          const i = before === null ? w.events.length : w.events.findIndex((e) => e.uuid === before);
          if (i >= 0 && (i >= limit || w.low === 0)) return { ok: true, events: w.events.slice(Math.max(0, i - limit), i) };
          if (w.low === 0) return { ok: false, error: "stale_cursor" };
          await readBackward(w);
        }
      } catch (e) {
        return { ok: false, error: (e as NodeJS.ErrnoException).code === "ENOENT" ? "no_transcript" : "internal" };
      }
    },

    follow(ids) {
      for (const id of new Set([...followed, ...windows.keys()])) {
        if (ids.has(id)) continue;
        followed.delete(id);
        windows.get(id)?.watcher?.close();
        windows.delete(id);
      }
      for (const id of ids) {
        followed.add(id);
        if (!windows.get(id)?.watcher && !opening.has(id)) void startFollowing(id);
      }
    },

    onAppend(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function parse(buf: Buffer): ChatEvent[] {
  return buf
    .toString("utf8")
    .split("\n")
    .filter(mayBeChatLine)
    .flatMap(lineToEvents);
}

function unseen(w: TranscriptWindow, events: ChatEvent[]): ChatEvent[] {
  const fresh = events.filter((e) => !w.seen.has(e.uuid));
  for (const e of fresh) w.seen.add(e.uuid);
  return fresh;
}

/** The offset just after the last 0x0A, so a half-written last line is read later, whole. */
async function lastLineStart(fh: FileHandle, size: number): Promise<number> {
  for (let end = size; end > 0; ) {
    const start = Math.max(0, end - BLOCK);
    const nl = (await readAt(fh, start, end)).lastIndexOf(0x0a);
    if (nl >= 0) return start + nl + 1;
    end = start;
  }
  return 0;
}

async function readAt(fh: FileHandle, start: number, end: number): Promise<Buffer> {
  const buf = Buffer.alloc(end - start);
  let done = 0;
  while (done < buf.length) {
    const { bytesRead } = await fh.read(buf, done, buf.length - done, start + done);
    if (bytesRead === 0) return buf.subarray(0, done);
    done += bytesRead;
  }
  return buf;
}

async function withFile<T>(path: string, fn: (fh: FileHandle) => Promise<T>): Promise<T> {
  const fh = await open(path, "r");
  try {
    return await fn(fh);
  } finally {
    await fh.close();
  }
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (st) => st.isFile(),
    () => false,
  );
}
