import type { ChatEvent, ClaudeSessionId } from "#shared/domain";
import type { Result } from "#shared/errors";

import { lineToEvents, mayBeChatLine } from "./records.ts";

export { blockedDialog, dialogId } from "./blocked.ts";

/**
 * Claude transcripts on this Mac, keyed by Claude session id. One window per file serves both paging and
 * following, so an HTTP page and a WS push can never disagree about where the file was read.
 */
export interface Transcripts {
  /** Finds `<root>/*\/<id>.jsonl` (spec 4.4: never computed from cwd). Hits are cached; misses search again after 10 s. */
  locate(id: ClaudeSessionId): Promise<string | null>;
  /**
   * Events strictly older than `before` (the newest when null), oldest first, at most `limit`.
   * The window grows backward until it holds `before` plus `limit` older events, or reaches the file start.
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
 */
interface TranscriptWindow {
  path: string;
  events: ChatEvent[];
  seen: Set<string>;
  low: number;
  high: number;
  watcher: { close(): void } | null;
  forward: Promise<void> | null;
  backward: Promise<void> | null;
  dirty: boolean;
}

export function createTranscripts(root: string): Transcripts {
  // TODO state: located: Map<ClaudeSessionId, { path: string | null; at: number }>; windows: Map<ClaudeSessionId, TranscriptWindow>
  //
  // locate(id): readdir(root) → first dir with stat(join(root, dir, `${id}.jsonl`)) ok; realpath must stay under root (spec 10)
  //
  // open(id): path = await locate(id); size = stat.size; low = high = last line start at or before size
  //           (scan back for 0x0A in the last block, so a half-written last line is read later, whole)
  //
  // page(id, before, limit): w = windows.get(id) ?? await open(id); loop:
  //   i = before === null ? w.events.length : w.events.findIndex(e => e.uuid === before)
  //   if (i >= 0 && (i >= limit || w.low === 0)) return ok(w.events.slice(max(0, i - limit), i))
  //   if (w.low === 0) return { ok: false, error: "stale_cursor" }
  //   await readBackward(w)
  //
  // readBackward(w), single flight: start = max(0, low - BLOCK); BLOCK = 256 KiB, doubled while the block holds no 0x0A
  //   (one tool result line can exceed a block); whole lines are those after the first 0x0A (all of them when start === 0);
  //   parse with mayBeChatLine + lineToEvents; prepend events not in seen; low = start + firstNewline + 1 (or 0)
  //
  // follow(ids): each new id → reuse the window page() may have opened (else open), fs.watch(path, () => readForward(w)),
  //   and one readForward now, so bytes appended since that page are pushed; ids not listed → watcher.close(), windows.delete
  //
  // readForward(w), single flight; an event during a read sets dirty and loops once more:
  //   size < w.high → file replaced: reset the window with open(id); the phone dedupes by uuid
  //   read [high, size); cut after the last 0x0A; parse; append events not in seen; high += consumed bytes; emit(id, appended)
  throw new Error("not implemented");
}
