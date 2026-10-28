import type { JSX } from "preact";
import type { Session } from "#shared/domain";
import type { BlockedState, ChatThread, Pending, Tab } from "../store.ts";
import type { Bubble } from "../view.ts";

/** "loading" → skeleton; gone from a received list → ClosedCard ("세션이 닫혔습니다" + 목록으로). The tab defaults to chat only if chatAvailable. */
export function SessionScreen(props: { session: Session | "gone" | "loading"; tab: Tab }): JSX.Element {
  throw new Error("not implemented");
}
export function SessionHeader(props: { session: Session; tab: Tab; chatEnabled: boolean; onTab(tab: Tab): void }): JSX.Element {
  throw new Error("not implemented");
}

/** On mount openChat(id). When status is blocked and blocked.forSeq !== stateChangeSeq, loadBlocked(id, seq). */
export function ChatView(props: { session: Session; thread: ChatThread | undefined; blocked: BlockedState | undefined; pending: Pending[] }): JSX.Element {
  throw new Error("not implemented");
}

/**
 * Auto-scrolls only when already at the bottom; otherwise NewMessagesPill. Pending bubbles render after the events
 * with pendingLabel(p, session, now), and a 1 s clock in this component re-renders them; the store is not touched.
 */
export function MessageList(props: { session: Session; bubbles: Bubble[]; pending: Pending[]; onReachTop(): void; topState: "more" | "loading" | "start" }): JSX.Element {
  throw new Error("not implemented");
}

/** Assistant text as plain text with line breaks kept. Never innerHTML: Claude output can quote web pages. */
export function AssistantBubble(props: { text: string }): JSX.Element {
  throw new Error("not implemented");
}

export function ToolGroup(props: { bubble: Extract<Bubble, { kind: "tools" }> }): JSX.Element {
  throw new Error("not implemented");
}

/**
 * Raw detection text (mono) plus one button per option, each sending sendKeys(id, [option.key], { dialogId }).
 * options [] → the KEY_PRESETS rows with dialog: true, guarded the same way. Buttons exist only while
 * state.forSeq === session.stateChangeSeq and !state.answered. Always carries "글로 답하려면 터미널 탭에서 입력하세요".
 */
export function BlockedCard(props: { session: Session; state: BlockedState | undefined }): JSX.Element {
  throw new Error("not implemented");
}

/** Mode from STATUS_VIEW[status].composer. Keeps the draft until command_result ok; follows visualViewport above the keyboard. */
export function Composer(props: { session: Session; draft: string; sending: boolean }): JSX.Element {
  throw new Error("not implemented");
}
