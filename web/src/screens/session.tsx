import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Session, SessionId } from "#shared/domain";
import { ERROR_INFO } from "#shared/errors";
import { fileName, viewableType } from "#shared/files";
import { KEY_PRESETS } from "#shared/keys";
import { fileUrl } from "../api.ts";
import { useNow } from "../clock.ts";
import { goBack } from "../router.ts";
import { dispatch, loadBlocked, loadOlder, openChat, pendingLabel, sendKeys, sendPrompt, state } from "../store.ts";
import type { BlockedState, ChatThread, Pending, PendingLabel, Tab } from "../store.ts";
import { STATUS_VIEW, chatAvailable, renderMarkdown, toBubbles } from "../view.ts";
import type { Bubble } from "../view.ts";
import { StatusPill } from "./sessions.tsx";
import { TerminalView } from "./terminal.tsx";

const SKELETON_BUBBLES = 3;
const AT_BOTTOM_PX = 48;
const COMPOSER_MAX_PX = 140;

/** "loading" → skeleton; gone from a received list → ClosedCard ("세션이 닫혔습니다" + 목록으로). The tab defaults to chat only if chatAvailable. */
export function SessionScreen(props: { session: Session | "gone" | "loading"; tab: Tab }): JSX.Element {
  const { session, tab } = props;
  if (session === "gone") {
    return (
      <div class="screen">
        <header class="header">
          <button class="header__back" type="button" onClick={() => goBack({ name: "sessions" })}>
            ‹ 세션
          </button>
        </header>
        <ClosedCard />
      </div>
    );
  }
  if (session === "loading") {
    return (
      <div class="screen">
        <header class="header">
          <button class="header__back" type="button" onClick={() => goBack({ name: "sessions" })}>
            ‹ 세션
          </button>
        </header>
        <SkeletonBubbles />
      </div>
    );
  }

  const s = state.value;
  const chatEnabled = chatAvailable(session);
  const active: Tab = chatEnabled ? tab : "term";
  return (
    <div class="screen">
      <SessionHeader session={session} tab={active} chatEnabled={chatEnabled} onTab={(next) => dispatch({ type: "tab", sessionId: session.id, tab: next })} />
      {active === "chat" ? (
        <ChatView
          session={session}
          thread={s.chat.get(session.id)}
          blocked={s.blocked.get(session.id)}
          pending={[...s.pending.values()].filter((p) => p.sessionId === session.id)}
        />
      ) : (
        <TerminalView session={session} scale={s.ui.termScale} state={s.terminal.get(session.id)?.state ?? "live"} />
      )}
    </div>
  );
}

function ClosedCard(): JSX.Element {
  return (
    <div class="closed-card">
      <p>세션이 닫혔습니다.</p>
      <button class="btn btn--primary" type="button" onClick={() => goBack({ name: "sessions" })}>
        목록으로
      </button>
    </div>
  );
}

function SkeletonBubbles(): JSX.Element {
  return (
    <div class="messages-wrap">
      <div class="messages" aria-hidden="true">
        {Array.from({ length: SKELETON_BUBBLES }, (_, i) => (
          <div key={i} class={`bubble ${i % 2 === 0 ? "bubble--assistant" : "bubble--user"} bubble--pending`} style={{ width: `${70 - i * 15}%`, height: 44 }} />
        ))}
      </div>
    </div>
  );
}

export function SessionHeader(props: { session: Session; tab: Tab; chatEnabled: boolean; onTab(tab: Tab): void }): JSX.Element {
  const { session, tab, chatEnabled, onTab } = props;
  return (
    <div class="session-head">
      <header class="header">
        <button class="header__back" type="button" onClick={() => goBack({ name: "sessions" })}>
          ‹ 세션
        </button>
        <h1 class="header__title">{session.workspaceLabel}</h1>
        <StatusPill session={session} />
      </header>
      <div class="tabs" role="tablist">
        <button class="tab" type="button" role="tab" aria-selected={tab === "chat"} disabled={!chatEnabled} onClick={() => onTab("chat")}>
          대화
        </button>
        <button class="tab" type="button" role="tab" aria-selected={tab === "term"} onClick={() => onTab("term")}>
          터미널
        </button>
      </div>
    </div>
  );
}

/** On mount openChat(id). When status is blocked and blocked.forSeq !== stateChangeSeq, loadBlocked(id, seq). */
export function ChatView(props: { session: Session; thread: ChatThread | undefined; blocked: BlockedState | undefined; pending: Pending[] }): JSX.Element {
  const { session, thread, blocked, pending } = props;
  const store = state.value;
  const connectionOpen = store.connection.status === "open";

  // A reopened connection drops the thread (reduce), so this also refetches after every reconnect.
  useEffect(() => {
    void openChat(session.id);
  }, [session.id, session.claudeSessionId, connectionOpen]);

  useEffect(() => {
    if (session.status === "blocked" && blocked?.forSeq !== session.stateChangeSeq) void loadBlocked(session.id, session.stateChangeSeq);
  }, [session.id, session.status, session.stateChangeSeq, blocked?.forSeq]);

  const bubbles = useMemo(() => toBubbles(thread?.events ?? []), [thread?.events]);
  const topState = !thread?.latestLoaded || thread.loadingOlder ? "loading" : thread.exhausted ? "start" : "more";
  const loaded = thread?.latestLoaded === true;

  return (
    <div class="chat">
      {loaded ? (
        <MessageList session={session} bubbles={bubbles} pending={pending} onReachTop={() => void loadOlder(session.id)} topState={topState} />
      ) : (
        <SkeletonBubbles />
      )}
      {session.status === "blocked" && <BlockedCard session={session} state={blocked} />}
      <Composer session={session} draft={store.drafts.get(session.id) ?? ""} sending={pending.some((p) => p.phase === "sending")} />
    </div>
  );
}

const bubbleKey = (b: Bubble) => (b.kind === "tools" ? b.key : b.event.uuid);

const PENDING_TEXT: Record<Exclude<PendingLabel, "failed">, string> = {
  sending: "전송 중입니다.",
  queued: "대기열에 들어갔습니다. Claude가 작업을 마치면 읽습니다.",
  unconfirmed: "전달되었는지 알 수 없습니다. Mac 화면을 확인하세요.",
};

/**
 * Auto-scrolls only when already at the bottom; otherwise NewMessagesPill. Pending bubbles render after the events
 * with pendingLabel(p, session, now), and a 1 s clock in this component re-renders them; the store is not touched.
 */
export function MessageList(props: { session: Session; bubbles: Bubble[]; pending: Pending[]; onReachTop(): void; topState: "more" | "loading" | "start" }): JSX.Element {
  const { session, bubbles, pending, onReachTop, topState } = props;
  const box = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const seen = useRef({ firstKey: "", lastKey: "", height: 0, pending: 0 });
  const [unseen, setUnseen] = useState(false);
  const now = useNow(1000, pending.length > 0);

  const scrollToBottom = () => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setUnseen(false);
  };

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const prev = seen.current;
    const firstKey = bubbles[0] ? bubbleKey(bubbles[0]) : "";
    const lastKey = bubbles.length > 0 ? bubbleKey(bubbles[bubbles.length - 1]!) : "";
    if (prev.firstKey !== "" && firstKey !== prev.firstKey) {
      // Older events were prepended: keep the message the reader was looking at where it was.
      el.scrollTop += el.scrollHeight - prev.height;
    } else if (atBottom.current || pending.length > prev.pending) {
      scrollToBottom();
    } else if (prev.lastKey !== "" && lastKey !== prev.lastKey) {
      setUnseen(true);
    }
    seen.current = { firstKey, lastKey, height: el.scrollHeight, pending: pending.length };
  }, [bubbles, pending.length]);

  // The keyboard or a rotation changes the box height; a reader at the bottom stays there.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Re-created whenever topState changes, so a sentinel still in view after a page loads fires again.
  useEffect(() => {
    const root = box.current;
    const target = sentinel.current;
    if (!root || !target || topState !== "more") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onReachTop();
      },
      { root, rootMargin: "200px 0px 0px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [topState, session.id]);

  return (
    <div class="messages-wrap">
      <div
        class="messages"
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_PX;
          if (atBottom.current) setUnseen(false);
        }}
      >
        <div class="messages__top" ref={sentinel}>
          {topState === "loading" ? "이전 대화를 불러오는 중입니다." : topState === "start" ? "대화의 처음입니다." : ""}
        </div>
        {bubbles.map((b) =>
          b.kind === "user" ? (
            <div key={b.event.uuid} class="bubble bubble--user">
              {b.event.text}
            </div>
          ) : b.kind === "assistant" ? (
            <AssistantBubble key={b.event.uuid} text={b.event.text} />
          ) : (
            <ToolGroup key={b.key} sessionId={session.id} bubble={b} />
          ),
        )}
        {pending.map((p) => {
          const label = pendingLabel(p, session, now);
          return (
            <div key={`${p.sentAt}:${p.text}`} class={`bubble bubble--user bubble--pending${label === "failed" ? " bubble--failed" : ""}`}>
              {p.text}
              <span class="bubble__status">{label === "failed" ? ERROR_INFO[p.error ?? "internal"].phone : PENDING_TEXT[label]}</span>
            </div>
          );
        })}
        {session.status === "working" && <div class="working">Claude가 작업 중입니다…</div>}
      </div>
      {unseen && (
        <button class="new-pill" type="button" onClick={scrollToBottom}>
          새 메시지 ↓
        </button>
      )}
    </div>
  );
}

/** Assistant text rendered by markdown-it with html: false, so Claude output that quotes web pages stays text. */
export function AssistantBubble(props: { text: string }): JSX.Element {
  const html = useMemo(() => renderMarkdown(props.text), [props.text]);
  return <div class="bubble bubble--assistant md" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Files the run wrote that a browser can show (shared/files.ts) are linked under the chip, visible without expanding it. */
export function ToolGroup(props: { sessionId: SessionId; bubble: Extract<Bubble, { kind: "tools" }> }): JSX.Element {
  const { sessionId, bubble } = props;
  const [open, setOpen] = useState(false);
  const files = [...new Set(bubble.items.flatMap(({ use }) => (use.path && viewableType(use.path) ? [use.path] : [])))];
  return (
    <div class="tools">
      <button class="chip" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        {bubble.counts}
      </button>
      {files.length > 0 && (
        <div class="tools__files">
          {files.map((path) => (
            <a class="tools__file" key={path} href={fileUrl(sessionId, path)} target="_blank" rel="noopener noreferrer" title={path}>
              {fileName(path)}
            </a>
          ))}
        </div>
      )}
      {open && (
        <ul class="tools__list">
          {bubble.items.map(({ use, result }) => (
            <li class="tools__item" key={use.uuid}>
              <div class="tools__use">{use.summary}</div>
              {result && <div class={`tools__result${result.isError ? " tools__result--error" : ""}`}>{result.preview}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Raw detection text (mono) plus one button per option, each sending sendKeys(id, [option.key], { dialogId }).
 * options [] → the KEY_PRESETS rows with dialog: true, guarded the same way. Buttons exist only while
 * state.forSeq === session.stateChangeSeq and !state.answered. Always carries "글로 답하려면 터미널 탭에서 입력하세요".
 */
export function BlockedCard(props: { session: Session; state: BlockedState | undefined }): JSX.Element {
  const { session, state: blocked } = props;
  const current = blocked !== undefined && blocked.forSeq === session.stateChangeSeq ? blocked : undefined;
  const answer = (key: string) => sendKeys(session.id, [key], { dialogId: current!.dialog.dialogId });
  const text = useRef<HTMLPreElement>(null);
  // The dialog is the bottom of the screen text, so the box opens scrolled to its end (measured on console-test).
  useEffect(() => {
    if (text.current) text.current.scrollTop = text.current.scrollHeight;
  }, [current?.dialog.dialogId]);
  return (
    <section class="approval" aria-label="승인 요청">
      <div class="approval__head">승인 필요</div>
      {current ? (
        <pre class="approval__text" ref={text}>
          {current.dialog.text}
        </pre>
      ) : (
        <p class="approval__note">승인 화면을 읽는 중입니다.</p>
      )}
      {current && !current.answered && current.dialog.options.length > 0 && (
        <div class="approval__options approval__options--list">
          {current.dialog.options.map((o) => (
            <button class="btn" type="button" key={o.key} onClick={() => answer(o.key)}>
              {o.key}. {o.label}
            </button>
          ))}
        </div>
      )}
      {current && !current.answered && current.dialog.options.length === 0 && (
        <>
          <p class="approval__note">선택지를 인식하지 못했습니다. 위 원문을 확인하고 아래 키로 답하세요.</p>
          <div class="approval__options">
            {KEY_PRESETS.filter((k) => k.dialog).map((k) => (
              <button class="btn" type="button" key={k.key} onClick={() => answer(k.key)}>
                {k.label}
              </button>
            ))}
          </div>
        </>
      )}
      {current?.answered && <p class="approval__note">답을 보냈습니다. 화면이 바뀌기를 기다리는 중입니다.</p>}
      <p class="approval__note">
        글로 답하려면 터미널 탭에서 입력하세요.{" "}
        <button class="link-btn" type="button" onClick={() => dispatch({ type: "tab", sessionId: session.id, tab: "term" })}>
          터미널 탭 열기
        </button>
      </p>
    </section>
  );
}

/** Mode from STATUS_VIEW[status].composer. Keeps the draft until command_result ok. App's useVisualViewport keeps it above the iOS keyboard. */
export function Composer(props: { session: Session; draft: string; sending: boolean }): JSX.Element {
  const { session, draft, sending } = props;
  const mode = STATUS_VIEW[session.status].composer;
  const field = useRef<HTMLTextAreaElement>(null);
  const canSend = mode !== "blocked" && !sending && draft.trim() !== "";

  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, COMPOSER_MAX_PX)}px`;
    el.style.overflowY = el.scrollHeight + 2 > COMPOSER_MAX_PX ? "auto" : "hidden";
  }, [draft]);

  const send = () => {
    if (canSend) sendPrompt(session.id, draft.trim());
  };
  return (
    <div class="composer">
      {mode === "queue_hint" && <p class="composer__hint">작업 중입니다. 보내면 큐에 들어갑니다.</p>}
      {mode === "term_hint" && (
        <p class="composer__hint">
          상태를 확인할 수 없습니다.{" "}
          <button type="button" onClick={() => dispatch({ type: "tab", sessionId: session.id, tab: "term" })}>
            터미널 탭에서 화면을 확인하세요.
          </button>
        </p>
      )}
      <div class="composer__row">
        <textarea
          ref={field}
          class="composer__field"
          rows={1}
          value={draft}
          placeholder={mode === "blocked" ? "승인 요청에 먼저 답해 주세요" : "메시지 보내기"}
          disabled={mode === "blocked"}
          readOnly={sending}
          aria-label="메시지"
          onInput={(e) => dispatch({ type: "draft", sessionId: session.id, text: e.currentTarget.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button class="composer__send" type="button" aria-label="보내기" disabled={!canSend} onClick={send}>
          ↑
        </button>
      </div>
    </div>
  );
}
