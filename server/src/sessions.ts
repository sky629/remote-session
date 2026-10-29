import type { Session, SessionId, SessionList } from "#shared/domain";
import type { Transcripts } from "#claude";
import type { SessionSource } from "#source";

export interface SessionsDiff {
  added: SessionId[];
  removed: SessionId[];
  changed: SessionId[];
}

/** The single owner of the current list and of the poll loop (spec 5.2: 1.5 s, only while a phone is connected). */
export interface SessionRegistry {
  /** Polling on or off. Idempotent. Turning it on polls at once. A poll in flight when it turns off still applies. */
  setActive(active: boolean): void;
  /** The list from the last poll. */
  current(): SessionList;
  get(id: SessionId): Session | undefined;
  /** The list, polling once first if the last poll is older than the interval (curl while no phone is connected). */
  list(): Promise<SessionList>;
  /** Called after a poll whose sessions diff is not empty or whose groups differ. */
  subscribe(listener: (list: SessionList, diff: SessionsDiff) => void): () => void;
}

export function createSessionRegistry(deps: {
  sources: readonly SessionSource[];
  transcripts: Pick<Transcripts, "locate">;
  intervalMs: number;
}): SessionRegistry {
  let list: SessionList = { groups: [], sessions: [] };
  let byId = new Map<SessionId, Session>();
  let polledAt = 0;
  let active = false;
  let generation = 0;
  let inflight: Promise<void> | null = null;
  let timer: NodeJS.Timeout | undefined;
  const listeners = new Set<(list: SessionList, diff: SessionsDiff) => void>();

  /** Single flight: a second caller awaits the same promise. */
  function pollOnce(): Promise<void> {
    inflight ??= (async () => {
      const polls = await Promise.all(deps.sources.map((s) => s.poll()));
      const groups = polls.flatMap((p) => p.groups);
      const sessions = await Promise.all(
        polls
          .flatMap((p) => p.sessions)
          .map(async (r): Promise<Session> => ({ ...r, transcriptPath: r.claudeSessionId ? await deps.transcripts.locate(r.claudeSessionId) : null })),
      );
      const diff = diffSessions(byId, sessions);
      const groupsMoved = JSON.stringify(groups) !== JSON.stringify(list.groups);
      list = { groups, sessions };
      byId = new Map(sessions.map((s) => [s.id, s]));
      polledAt = Date.now();
      if (diff.added.length || diff.removed.length || diff.changed.length || groupsMoved) for (const l of listeners) l(list, diff);
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  // Off then on during a poll: the old chain sees a stale generation and stops; only the new chain reschedules.
  async function loop(gen: number): Promise<void> {
    try {
      await pollOnce();
    } catch (e) {
      console.error(`session poll failed: ${(e as Error).message}`);
    }
    if (active && gen === generation) timer = setTimeout(() => void loop(gen), deps.intervalMs);
  }

  return {
    setActive(on) {
      if (on === active) return;
      active = on;
      clearTimeout(timer);
      if (on) void loop(++generation);
    },
    current: () => list,
    get: (id) => byId.get(id),
    async list() {
      if (Date.now() - polledAt >= deps.intervalMs) await pollOnce();
      return list;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** Pure. Rows compare field by field over Object.keys, so a new Session field needs no edit here. */
export function diffSessions(prev: ReadonlyMap<SessionId, Session>, next: readonly Session[]): SessionsDiff {
  const diff: SessionsDiff = { added: [], removed: [], changed: [] };
  const seen = new Set<SessionId>();
  for (const s of next) {
    seen.add(s.id);
    const old = prev.get(s.id);
    if (!old) diff.added.push(s.id);
    else if ((Object.keys(s) as (keyof Session)[]).some((k) => s[k] !== old[k])) diff.changed.push(s.id);
  }
  for (const id of prev.keys()) if (!seen.has(id)) diff.removed.push(id);
  return diff;
}
