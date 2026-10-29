import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentStatus, BlockedDialog, ChatEvent, ClaudeSessionId, Session, SessionId } from "#shared/domain";
import { ERROR_INFO } from "#shared/errors";
import type { ErrorCode } from "#shared/errors";
import type { RequestId } from "#shared/protocol";
import { THREAD_CAP, dispatch, pendingLabel, reduce, state } from "./store.ts";
import type { Action, AppState, BlockedState, ChatThread, Pending } from "./store.ts";

const CLAUDE_A = "f2e47829-9e38-414c-811f-395503e66ba8" as ClaudeSessionId;
const CLAUDE_B = "173980c4-0d59-4741-aa45-320358812608" as ClaudeSessionId;
const ID1 = "herdr:default/w1:p1" as SessionId;
const ID2 = "herdr:default/w2:p1" as SessionId;
const REQ1 = "req-00000001" as RequestId;
const REQ2 = "req-00000002" as RequestId;

function session(id: SessionId, status: AgentStatus = "idle", claudeSessionId: ClaudeSessionId | null = CLAUDE_A, stateChangeSeq = 1): Session {
  return {
    id,
    source: "herdr",
    group: "default",
    paneId: id.split("/")[1]!,
    terminalId: "term_1",
    workspaceLabel: "label",
    title: null,
    cwd: null,
    agent: "claude",
    claudeSessionId,
    stateChangeSeq,
    transcriptPath: "/x.jsonl",
    reachable: true,
    status,
  };
}

function initial(rows: Session[] = [session(ID1), session(ID2, "idle", CLAUDE_B)], overrides: Partial<AppState> = {}): AppState {
  return {
    me: { status: "member", tailscaleLogin: "me@example.com", deviceName: null },
    connection: { status: "open" },
    sessions: { groups: [{ source: "herdr", name: "default", reachable: true }], byId: new Map(rows.map((r) => [r.id, r])) },
    statusSince: new Map(),
    chat: new Map(),
    blocked: new Map(),
    commands: new Map(),
    terminal: new Map(),
    pending: new Map(),
    drafts: new Map(),
    ui: { route: { name: "sessions" }, tab: new Map(), termScale: "fit", toast: null },
    ...overrides,
  };
}

const sessionsMsg = (rows: Session[]): Action => ({ type: "sessions", groups: [{ source: "herdr", name: "default", reachable: true }], sessions: rows });
const ts = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
const user = (uuid: string, n: number, text = uuid): ChatEvent => ({ kind: "user_text", uuid, ts: ts(n), text });
const thread = (events: ChatEvent[], extra: Partial<ChatThread> = {}, claudeSessionId = CLAUDE_A): ChatThread => ({
  claudeSessionId,
  events,
  latestLoaded: true,
  loadingOlder: false,
  exhausted: false,
  ...extra,
});
const pendingOf = (text: string, phase: Pending["phase"] = "delivered", sessionId = ID1, error?: ErrorCode): Pending => ({ sessionId, text, sentAt: 1000, phase, error });
const dialog = (dialogId: string): BlockedDialog => ({ text: "Do you want to proceed?", options: [{ key: "1", label: "Yes" }], dialogId });
const blockedState = (forSeq: number, dialogId = "d1", answered = false): BlockedState => ({ forSeq, dialog: dialog(dialogId), answered });
const manyEvents = (n: number): ChatEvent[] => Array.from({ length: n }, (_, i) => user(`e${i}`, i));

describe("sessions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(50_000);
  });
  afterEach(() => vi.useRealTimers());

  test("replaces the list whole and keeps the groups, including an empty one", () => {
    const empty = { source: "herdr" as const, name: "rocket", reachable: true };
    const next = reduce(initial(), { type: "sessions", groups: [{ source: "herdr", name: "default", reachable: true }, empty], sessions: [session(ID2)] });
    expect([...next.sessions!.byId.keys()]).toEqual([ID2]);
    expect(next.sessions!.groups).toHaveLength(2);
  });

  test("drops a thread whose pane now runs another Claude session, and one whose pane is gone", () => {
    const s = initial(undefined, { chat: new Map([[ID1, thread([user("a", 1)])], [ID2, thread([user("b", 1)], {}, CLAUDE_B)]]) });
    const next = reduce(s, sessionsMsg([session(ID1, "idle", CLAUDE_B)]));
    expect(next.chat.size).toBe(0);
  });

  test("keeps a thread whose claudeSessionId is unchanged", () => {
    const s = initial(undefined, { chat: new Map([[ID1, thread([user("a", 1)])]]) });
    expect(reduce(s, sessionsMsg([session(ID1, "working")])).chat.get(ID1)).toBe(s.chat.get(ID1));
  });

  test("stamps statusSince only where stateChangeSeq moved", () => {
    const s = initial([session(ID1, "idle", CLAUDE_A, 1), session(ID2, "idle", CLAUDE_B, 1)]);
    const next = reduce(s, sessionsMsg([session(ID1, "working", CLAUDE_A, 2), session(ID2, "idle", CLAUDE_B, 1)]));
    expect([...next.statusSince]).toEqual([[ID1, 50_000]]);
  });

  test("drops a blocked dialog once the session left blocked", () => {
    const s = initial([session(ID1, "blocked", CLAUDE_A, 3)], { blocked: new Map([[ID1, blockedState(3)]]) });
    expect(reduce(s, sessionsMsg([session(ID1, "blocked", CLAUDE_A, 3)])).blocked.size).toBe(1);
    expect(reduce(s, sessionsMsg([session(ID1, "working", CLAUDE_A, 4)])).blocked.size).toBe(0);
  });
});

describe("chat push", () => {
  test("is ignored for a session without a Claude id, and creates the thread otherwise", () => {
    const bare = initial([session(ID1, "idle", null)]);
    expect(reduce(bare, { type: "chat", sessionId: ID1, events: [user("a", 1)] })).toBe(bare);
    const next = reduce(initial(), { type: "chat", sessionId: ID1, events: [user("a", 1)] });
    expect(next.chat.get(ID1)).toMatchObject({ claudeSessionId: CLAUDE_A, latestLoaded: false });
    expect(next.chat.get(ID1)!.events.map((e) => e.uuid)).toEqual(["a"]);
  });

  test("merges by uuid and keeps ts order", () => {
    const s = initial(undefined, { chat: new Map([[ID1, thread([user("a", 1), user("c", 3)])]]) });
    const next = reduce(s, { type: "chat", sessionId: ID1, events: [user("b", 2), user("c", 3)] });
    expect(next.chat.get(ID1)!.events.map((e) => e.uuid)).toEqual(["a", "b", "c"]);
  });

  test("a duplicate-only push returns the same state", () => {
    const s = initial(undefined, { chat: new Map([[ID1, thread([user("a", 1)])]]) });
    expect(reduce(s, { type: "chat", sessionId: ID1, events: [user("a", 1)] })).toBe(s);
  });

  test("an echoed user_text removes the oldest matching pending of that session only", () => {
    const s = initial(undefined, {
      pending: new Map([
        [REQ1, pendingOf("안녕")],
        [REQ2, pendingOf("안녕")],
      ]),
    });
    const next = reduce(s, { type: "chat", sessionId: ID1, events: [user("u1", 1, "안녕")] });
    expect([...next.pending.keys()]).toEqual([REQ2]);
    const other = reduce(s, { type: "chat", sessionId: ID2, events: [user("u1", 1, "안녕")] });
    expect(other.pending.size).toBe(2);
  });

  test("a redelivered echo does not remove a second pending", () => {
    const s = initial(undefined, { pending: new Map([[REQ1, pendingOf("a")], [REQ2, pendingOf("a")]]) });
    const once = reduce(s, { type: "chat", sessionId: ID1, events: [user("u1", 1, "a")] });
    expect(reduce(once, { type: "chat", sessionId: ID1, events: [user("u1", 1, "a")] }).pending.size).toBe(1);
  });

  test("an echo that beats command_result also clears the draft that held the text", () => {
    const s = initial(undefined, { pending: new Map([[REQ1, pendingOf("hello", "sending")]]), drafts: new Map([[ID1, "hello "]]) });
    const next = reduce(s, { type: "chat", sessionId: ID1, events: [user("u1", 1, "hello")] });
    expect(next.pending.size).toBe(0);
    expect(next.drafts.has(ID1)).toBe(false);
  });

  test("a thread off screen is cut to THREAD_CAP, a thread on screen is not", () => {
    const s = initial(undefined, { chat: new Map([[ID1, thread(manyEvents(THREAD_CAP), { exhausted: true })]]) });
    const push: Action = { type: "chat", sessionId: ID1, events: [user("new", THREAD_CAP + 1)] };
    const off = reduce(s, push).chat.get(ID1)!;
    expect(off.events).toHaveLength(THREAD_CAP);
    expect(off.events.at(-1)!.uuid).toBe("new");
    expect(off.exhausted).toBe(false);
    const on = reduce({ ...s, ui: { ...s.ui, route: { name: "session", sessionId: ID1 } } }, push).chat.get(ID1)!;
    expect(on.events).toHaveLength(THREAD_CAP + 1);
    expect(on.exhausted).toBe(true);
  });
});

describe("chat_page", () => {
  const page = (events: ChatEvent[], older: boolean, claudeSessionId = CLAUDE_A): Action => ({ type: "chat_page", sessionId: ID1, claudeSessionId, events, limit: 3, older });

  test("the latest page marks the thread loaded, and a short page also marks it exhausted", () => {
    const full = reduce(initial(), page([user("a", 1), user("b", 2), user("c", 3)], false)).chat.get(ID1)!;
    expect(full).toMatchObject({ latestLoaded: true, exhausted: false });
    const short = reduce(initial(), page([user("a", 1)], false)).chat.get(ID1)!;
    expect(short).toMatchObject({ latestLoaded: true, exhausted: true });
  });

  test("an older page merges in front, clears loadingOlder and sets exhausted from its length", () => {
    const s = initial(undefined, { chat: new Map([[ID1, thread([user("d", 4)], { loadingOlder: true })]]) });
    const more = reduce(s, page([user("a", 1), user("b", 2), user("c", 3)], true)).chat.get(ID1)!;
    expect(more.events.map((e) => e.uuid)).toEqual(["a", "b", "c", "d"]);
    expect(more).toMatchObject({ loadingOlder: false, exhausted: false });
    expect(reduce(s, page([user("c", 3)], true)).chat.get(ID1)).toMatchObject({ loadingOlder: false, exhausted: true });
  });

  test("a page for another Claude session is ignored", () => {
    const s = initial(undefined, { chat: new Map([[ID1, thread([user("d", 4)])]]) });
    expect(reduce(s, page([user("a", 1)], false, CLAUDE_B))).toBe(s);
  });

  test("a page never touches pending bubbles", () => {
    const s = initial(undefined, { pending: new Map([[REQ1, pendingOf("a")]]) });
    expect(reduce(s, page([user("u", 1, "a")], false)).pending).toBe(s.pending);
  });
});

describe("command_result", () => {
  const ok = (requestId: RequestId): Action => ({ type: "command_result", requestId, ok: true });
  const fail = (requestId: RequestId, error: ErrorCode): Action => ({ type: "command_result", requestId, ok: false, error });

  test("ok on a prompt marks it delivered and spends the draft", () => {
    const s = initial(undefined, { pending: new Map([[REQ1, pendingOf("hi", "sending")]]), drafts: new Map([[ID1, "hi"]]) });
    const next = reduce(s, ok(REQ1));
    expect(next.pending.get(REQ1)!.phase).toBe("delivered");
    expect(next.drafts.has(ID1)).toBe(false);
  });

  test("ok on a slash command drops it at once: Claude Code runs it locally and may never echo it", () => {
    const s = initial(undefined, { pending: new Map([[REQ1, pendingOf("/cost", "sending")]]), drafts: new Map([[ID1, "/cost"]]) });
    const next = reduce(s, ok(REQ1));
    expect(next.pending.has(REQ1)).toBe(false);
    expect(next.drafts.has(ID1)).toBe(false);
  });

  test("an error on a prompt marks it failed with the code and keeps the draft", () => {
    const s = initial(undefined, { pending: new Map([[REQ1, pendingOf("hi", "sending")]]), drafts: new Map([[ID1, "hi"]]) });
    const next = reduce(s, fail(REQ1, "agent_blocked"));
    expect(next.pending.get(REQ1)).toMatchObject({ phase: "failed", error: "agent_blocked" });
    expect(next.drafts.get(ID1)).toBe("hi");
    expect(next.ui.toast).toBeNull();
  });

  test("ok on any other command changes nothing", () => {
    const s = initial();
    expect(reduce(s, ok(REQ2))).toBe(s);
  });

  test("an error on any other command toasts the ERROR_INFO text", () => {
    expect(reduce(initial(), fail(REQ2, "pane_closed")).ui.toast).toBe(ERROR_INFO.pane_closed.phone);
  });

  test("stale_dialog toasts and drops the answered dialogs so they reload", () => {
    const s = initial(undefined, { blocked: new Map([[ID1, blockedState(1, "d1", true)], [ID2, blockedState(1, "d2", false)]]) });
    const next = reduce(s, fail(REQ2, "stale_dialog"));
    expect(next.ui.toast).toBe(ERROR_INFO.stale_dialog.phone);
    expect([...next.blocked.keys()]).toEqual([ID2]);
  });
});

describe("blocked", () => {
  const fetched = (dialogId: string, forSeq = 1): Action => ({ type: "blocked", sessionId: ID1, forSeq, dialog: dialog(dialogId) });

  test("a re-read that finds the answered dialog keeps the buttons off", () => {
    const s = initial(undefined, { blocked: new Map([[ID1, blockedState(1, "d1", true)]]) });
    expect(reduce(s, fetched("d1"))).toBe(s);
  });

  test("a new dialog text in the same seq is a new dialog and enables the buttons again", () => {
    const s = initial(undefined, { blocked: new Map([[ID1, blockedState(1, "d1", true)]]) });
    expect(reduce(s, fetched("d2")).blocked.get(ID1)).toMatchObject({ answered: false, dialog: { dialogId: "d2" } });
  });

  test("blocked_answered marks the entry once", () => {
    const s = initial(undefined, { blocked: new Map([[ID1, blockedState(1)]]) });
    const answered = reduce(s, { type: "blocked_answered", sessionId: ID1 });
    expect(answered.blocked.get(ID1)!.answered).toBe(true);
    expect(reduce(answered, { type: "blocked_answered", sessionId: ID1 })).toBe(answered);
  });
});

describe("connection", () => {
  test("closing fails every sending prompt with delivery_unconfirmed and leaves the others", () => {
    const s = initial(undefined, {
      pending: new Map([
        [REQ1, pendingOf("a", "sending")],
        [REQ2, pendingOf("b", "delivered")],
      ]),
    });
    const next = reduce(s, { type: "connection", connection: { status: "closed", retryAt: 9 } });
    expect(next.pending.get(REQ1)).toMatchObject({ phase: "failed", error: "delivery_unconfirmed" });
    expect(next.pending.get(REQ2)!.phase).toBe("delivered");
  });

  test("reopening after a close drops the threads, because pushes sent in between never arrived", () => {
    const closed = initial(undefined, { connection: { status: "closed", retryAt: 9 }, chat: new Map([[ID1, thread([user("a", 1)])]]) });
    expect(reduce(closed, { type: "connection", connection: { status: "open" } }).chat.size).toBe(0);
    const first = initial(undefined, { connection: { status: "connecting" }, chat: new Map([[ID1, thread([user("a", 1)])]]) });
    expect(reduce(first, { type: "connection", connection: { status: "open" } }).chat.size).toBe(1);
  });

  test("the same state again returns the same object", () => {
    const s = initial();
    expect(reduce(s, { type: "connection", connection: { status: "open" } })).toBe(s);
  });
});

describe("route", () => {
  test("leaving a session cuts its thread to THREAD_CAP; an unchanged route changes nothing", () => {
    const onScreen = initial(undefined, {
      chat: new Map([[ID1, thread(manyEvents(THREAD_CAP + 40), { exhausted: true })]]),
      ui: { route: { name: "session", sessionId: ID1 }, tab: new Map(), termScale: "fit", toast: null },
    });
    expect(reduce(onScreen, { type: "route", route: { name: "session", sessionId: ID1 } })).toBe(onScreen);
    const left = reduce(onScreen, { type: "route", route: { name: "sessions" } });
    const cut = left.chat.get(ID1)!;
    expect(cut.events).toHaveLength(THREAD_CAP);
    expect(cut.events[0]!.uuid).toBe("e40");
    expect(cut.exhausted).toBe(false);
    expect(left.ui.route).toEqual({ name: "sessions" });
  });
});

describe("frames and terminal status", () => {
  const frame = (width: number, height: number): Action => ({ type: "frame", sessionId: ID1, width, height });

  test("a frame with the size already known returns the same state", () => {
    const s = reduce(initial(), frame(155, 54));
    expect(s.terminal.get(ID1)).toEqual({ width: 155, height: 54, state: "live" });
    expect(reduce(s, frame(155, 54))).toBe(s);
    expect(reduce(s, frame(80, 24)).terminal.get(ID1)).toMatchObject({ width: 80, height: 24 });
  });

  test("terminal_status sets the stream state and keeps the size", () => {
    const s = reduce(initial(), frame(155, 54));
    expect(reduce(s, { type: "terminal_status", sessionId: ID1, state: "restarting" }).terminal.get(ID1)).toEqual({ width: 155, height: 54, state: "restarting" });
  });
});

describe("prompt_sent, drafts and me", () => {
  test("a new send replaces the failed bubbles of that session only", () => {
    const s = initial(undefined, {
      pending: new Map([
        [REQ1, pendingOf("old", "failed", ID1, "agent_blocked")],
        [REQ2, pendingOf("other", "failed", ID2, "agent_blocked")],
      ]),
    });
    const next = reduce(s, { type: "prompt_sent", requestId: "req-00000003" as RequestId, sessionId: ID1, text: "new", at: 5 });
    expect([...next.pending.keys()]).toEqual([REQ2, "req-00000003"]);
    expect(next.pending.get("req-00000003" as RequestId)).toMatchObject({ phase: "sending", text: "new", sentAt: 5 });
  });

  test("an empty draft deletes the entry", () => {
    const typed = reduce(initial(), { type: "draft", sessionId: ID1, text: "abc" });
    expect(typed.drafts.get(ID1)).toBe("abc");
    expect(reduce(typed, { type: "draft", sessionId: ID1, text: "" }).drafts.size).toBe(0);
  });

  test("becoming anonymous clears everything the server sent but keeps the drafts", () => {
    const s = initial(undefined, { drafts: new Map([[ID1, "keep"]]), chat: new Map([[ID1, thread([user("a", 1)])]]), pending: new Map([[REQ1, pendingOf("a")]]) });
    const next = reduce(s, { type: "me", me: { status: "anonymous", tailscaleLogin: "me@example.com", deviceName: null, next: "/s/herdr/default/w1%3Ap1" } });
    expect(next.sessions).toBeNull();
    expect(next.chat.size + next.pending.size).toBe(0);
    expect(next.drafts.get(ID1)).toBe("keep");
  });
});

describe("pendingLabel", () => {
  const working = session(ID1, "working");
  const idle = session(ID1, "idle");
  const now = 1000 + 30_000;
  const cases: { name: string; p: Pending; s: Session | undefined; now: number; want: ReturnType<typeof pendingLabel> }[] = [
    { name: "failed, whatever the session does", p: pendingOf("a", "failed", ID1, "agent_blocked"), s: working, now, want: "failed" },
    { name: "still sending", p: pendingOf("a", "sending"), s: idle, now, want: "sending" },
    { name: "still sending while the session works", p: pendingOf("a", "sending"), s: working, now, want: "sending" },
    { name: "delivered while the session works", p: pendingOf("a", "delivered"), s: working, now, want: "queued" },
    { name: "delivered, idle, within 10 s", p: pendingOf("a", "delivered"), s: idle, now: 1000 + 10_000, want: "sending" },
    { name: "delivered, idle, older than 10 s", p: pendingOf("a", "delivered"), s: idle, now: 1000 + 10_001, want: "unconfirmed" },
    { name: "delivered to a session that vanished", p: pendingOf("a", "delivered"), s: undefined, now, want: "unconfirmed" },
  ];
  test.each(cases)("$name", ({ p, s, now: at, want }) => {
    expect(pendingLabel(p, s, at)).toBe(want);
  });
});

describe("draft persistence", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("a draft is written to localStorage under one key, and nothing else is", () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { setItem, getItem: () => null });
    dispatch({ type: "draft", sessionId: ID1, text: "unsent" });
    expect(setItem.mock.calls).toEqual([["console.drafts", JSON.stringify({ [ID1]: "unsent" })]]);
    dispatch({ type: "toast", text: "x" });
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(state.value.drafts.get(ID1)).toBe("unsent");
  });

  test("a storage that throws leaves the draft in memory", () => {
    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new Error("quota");
      },
      getItem: () => null,
    });
    dispatch({ type: "draft", sessionId: ID2, text: "kept" });
    expect(state.value.drafts.get(ID2)).toBe("kept");
  });
});
