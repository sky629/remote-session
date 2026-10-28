import MarkdownIt from "markdown-it";
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
  const rows = new Map<string, Session[]>();
  for (const s of sessions) {
    const key = `${s.source}:${s.group}`;
    const list = rows.get(key);
    if (list) list.push(s);
    else rows.set(key, [s]);
  }
  return groups.map((group) => ({
    group,
    label: `${group.source} · ${group.name}`,
    sessions: (rows.get(`${group.source}:${group.name}`) ?? []).sort(
      (a, b) => STATUS_VIEW[a.status].rank - STATUS_VIEW[b.status].rank || b.stateChangeSeq - a.stateChangeSeq,
    ),
  }));
}

/** The chat tab exists only for Claude sessions with a transcript (spec 2 non-goals); others open on the terminal tab. */
export function chatAvailable(s: Session): boolean {
  return s.agent === "claude" && s.transcriptPath !== null;
}

const tsOf = (e: ChatEvent): number => {
  const t = Date.parse(e.ts);
  return Number.isNaN(t) ? 0 : t;
};

/** Set union by uuid, ordered by ts with arrival order on ties. Commutative, so page and push races cannot reorder or duplicate. */
export function mergeEvents(base: readonly ChatEvent[], incoming: readonly ChatEvent[]): readonly ChatEvent[] {
  const seen = new Set(base.map((e) => e.uuid));
  const fresh: ChatEvent[] = [];
  for (const e of incoming) {
    if (seen.has(e.uuid)) continue;
    seen.add(e.uuid);
    fresh.push(e);
  }
  if (fresh.length === 0) return base;
  return [...base, ...fresh].sort((a, b) => tsOf(a) - tsOf(b));
}

const PASTE_TAG = /<\/?pasted_content\b[^>]*>/g;

function normalizeLines(text: string): string[] {
  return text
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(PASTE_TAG, "")
    .trim()
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim());
}

/**
 * Does a transcript user_text echo a sent prompt? Both sides: NFC, CRLF → LF, trim, whitespace runs collapsed.
 * Claude Code wraps long pastes in <pasted_content id="…">…</pasted_content> (measured), so those tags go first.
 * Equal after that, or the echo contains the sent text as whole lines: messages queued while working may come back
 * joined into one user record (inferred; check in the console-test session).
 */
export function echoMatches(sent: string, echoed: string): boolean {
  const wantText = normalizeLines(sent).join("\n");
  if (wantText === "") return false;
  const gotText = normalizeLines(echoed).join("\n");
  if (wantText === gotText) return true;
  return `\n${gotText}\n`.includes(`\n${wantText}\n`);
}

export type Bubble =
  | { kind: "user"; event: Extract<ChatEvent, { kind: "user_text" }> }
  | { kind: "assistant"; event: Extract<ChatEvent, { kind: "assistant_text" }> }
  /** A run of consecutive tool events. results join uses by toolUseId. counts → "Bash ×3 · Edit ×1". */
  | { kind: "tools"; key: string; items: { use: Extract<ChatEvent, { kind: "tool_use" }>; result?: Extract<ChatEvent, { kind: "tool_result" }> }[]; counts: string };

type ToolsBubble = Extract<Bubble, { kind: "tools" }>;

function countsOf(items: ToolsBubble["items"]): string {
  const counts = new Map<string, number>();
  for (const { use } of items) counts.set(use.name, (counts.get(use.name) ?? 0) + 1);
  return [...counts].map(([name, n]) => `${name} ×${n}`).join(" · ");
}

/**
 * A tool_result never starts or ends a run: it attaches to its tool_use wherever that sits. A result whose use
 * lies outside the loaded window (an older page not fetched yet) is left out.
 */
export function toBubbles(events: readonly ChatEvent[]): Bubble[] {
  const bubbles: Bubble[] = [];
  const itemByUse = new Map<string, ToolsBubble["items"][number]>();
  let run: ToolsBubble | null = null;
  for (const event of events) {
    switch (event.kind) {
      case "user_text":
        run = null;
        bubbles.push({ kind: "user", event });
        break;
      case "assistant_text":
        run = null;
        bubbles.push({ kind: "assistant", event });
        break;
      case "tool_use": {
        if (!run) {
          run = { kind: "tools", key: `tools:${event.uuid}`, items: [], counts: "" };
          bubbles.push(run);
        }
        const item: ToolsBubble["items"][number] = { use: event };
        run.items.push(item);
        itemByUse.set(event.toolUseId, item);
        break;
      }
      case "tool_result": {
        const item = itemByUse.get(event.toolUseId);
        if (item) item.result = event;
        break;
      }
    }
  }
  for (const b of bubbles) if (b.kind === "tools") b.counts = countsOf(b.items);
  return bubbles;
}

/** `/Users/kang/…` and `/home/kang/…` → `~/…`, as the list rows show paths (spec 8.1). */
export function shortPath(cwd: string | null): string {
  return cwd === null ? "" : cwd.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

/** "방금" under a minute, then 분, 시간, 일. */
export function relativeTime(since: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - since) / 1000));
  if (sec < 60) return "방금";
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}시간 전`;
  return `${Math.floor(sec / 86400)}일 전`;
}

// html: false leaves any markup in Claude's text as escaped text, and markdown-it refuses javascript: and data: links.
// Images are off because a remote image would be fetched the moment a quoted web page renders.
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: true }).disable("image");
const renderLinkOpen = markdown.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
markdown.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx]!.attrSet("target", "_blank");
  tokens[idx]!.attrSet("rel", "noopener noreferrer");
  return renderLinkOpen(tokens, idx, options, env, self);
};

/** HTML for an assistant bubble. Safe to inject: the only markup in it is what markdown-it generated. */
export function renderMarkdown(text: string): string {
  return markdown.render(text);
}
