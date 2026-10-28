import type { AgentStatus, ChatEvent, Session, SessionGroup } from "#shared/domain";

/** Spec 6.2 as one table. Sorting, the pill and the composer rule all read it; nothing else lists statuses. */
export const STATUS_VIEW: Readonly<
  Record<AgentStatus, { label: string; tone: "warning" | "info" | "neutral" | "success" | "muted"; rank: number; composer: "blocked" | "queue_hint" | "open" | "term_hint" }>
> = {
  blocked: { label: "승인 필요", tone: "warning", rank: 0, composer: "blocked" },
  working: { label: "작업 중", tone: "info", rank: 1, composer: "queue_hint" },
  idle: { label: "대기", tone: "neutral", rank: 2, composer: "open" },
  done: { label: "완료", tone: "success", rank: 2, composer: "open" },
  unknown: { label: "확인 불가", tone: "muted", rank: 3, composer: "term_hint" },
};

export interface GroupView {
  group: SessionGroup;
  label: string; // "herdr · default"
  sessions: Session[]; // rank ascending, then stateChangeSeq descending (spec 6.1)
}
/** One entry per group, empty groups included, in the order the server listed them. */
export function groupSessions(groups: readonly SessionGroup[], sessions: Iterable<Session>): GroupView[] {
  throw new Error("not implemented");
}

/** The chat tab exists only for Claude sessions with a transcript (spec 2 non-goals); others open on the terminal tab. */
export function chatAvailable(s: Session): boolean {
  return s.agent === "claude" && s.transcriptPath !== null;
}

/** Set union by uuid, ordered by ts with arrival order on ties. Commutative, so page and push races cannot reorder or duplicate. */
export function mergeEvents(base: readonly ChatEvent[], incoming: readonly ChatEvent[]): readonly ChatEvent[] {
  throw new Error("not implemented");
}

/**
 * Does a transcript user_text echo a sent prompt? Both sides: NFC, CRLF → LF, trim, whitespace runs collapsed.
 * Claude Code wraps long pastes in <pasted_content id="…">…</pasted_content> (measured), so those tags go first.
 * Equal after that, or the echo contains the sent text as whole lines: messages queued while working may come back
 * joined into one user record (inferred; check in the console-test session).
 */
export function echoMatches(sent: string, echoed: string): boolean {
  throw new Error("not implemented");
}

export type Bubble =
  | { kind: "user"; event: Extract<ChatEvent, { kind: "user_text" }> }
  | { kind: "assistant"; event: Extract<ChatEvent, { kind: "assistant_text" }> }
  /** A run of consecutive tool events. results join uses by toolUseId. counts → "Bash ×3 · Edit ×1". */
  | { kind: "tools"; key: string; items: { use: Extract<ChatEvent, { kind: "tool_use" }>; result?: Extract<ChatEvent, { kind: "tool_result" }> }[]; counts: string };
export function toBubbles(events: readonly ChatEvent[]): Bubble[] {
  throw new Error("not implemented");
}
