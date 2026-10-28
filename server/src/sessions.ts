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
  // TODO state: list: SessionList; byId: Map<SessionId, Session>; polledAt = 0; active = false; generation = 0; inflight; timer
  //
  // pollOnce(), single flight (a second caller awaits the same promise):
  //   polls = await Promise.all(sources.map(s => s.poll()))
  //   rows = polls.flatMap(p => p.sessions); groups = polls.flatMap(p => p.groups)
  //   sessions = await Promise.all(rows.map(async r => ({ ...r, transcriptPath: r.claudeSessionId ? await locate(r.claudeSessionId) : null })))
  //   diff = diffSessions(byId, sessions); groupsMoved = JSON.stringify(groups) !== JSON.stringify(list.groups)
  //   list = { groups, sessions }; byId = new Map(sessions.map(s => [s.id, s])); polledAt = now
  //   if (diff has any entry || groupsMoved) listeners.forEach(l => l(list, diff))
  //
  // setActive(true) from inactive: active = true; gen = ++generation; loop(gen)
  // loop(gen): await pollOnce(); if (active && gen === generation) timer = setTimeout(() => loop(gen), intervalMs)
  // setActive(false): active = false; clearTimeout(timer)
  // Off then on during a poll: the old chain sees a stale generation and stops; only the new chain reschedules.
  throw new Error("not implemented");
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
