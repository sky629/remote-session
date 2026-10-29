import { signal } from "@preact/signals";
import type { BlockedDialog, ChatEvent, ClaudeSessionId, Session, SessionGroup, SessionId, SlashCommand } from "#shared/domain";
import { ERROR_INFO } from "#shared/errors";
import type { ErrorCode } from "#shared/errors";
import type { LoginReply, RequestId, ServerMessage, TerminalState } from "#shared/protocol";
import { api } from "./api.ts";
import { connect, disconnect, sendCommand } from "./connection.ts";
import { navigate, parseRoute, startRouter } from "./router.ts";
import { echoMatches, mergeEvents } from "./view.ts";

export type Tab = "chat" | "term";
export type Route = { name: "login" } | { name: "sessions" } | { name: "session"; sessionId: SessionId };

/** A thread not on screen keeps only its newest THREAD_CAP events (spec 6.6); scrolling up later fetches the rest again. */
export const THREAD_CAP = 500;

/** Events per chat page request. The server clamps it to its own maximum. */
const CHAT_PAGE = 50;

/** The remembered deep link is state, not a flag. A 403 never reaches here: the server answers it with its own page. */
export type MeState =
  | { status: "loading" }
  | { status: "anonymous"; tailscaleLogin: string; deviceName: string | null; next: string }
  | { status: "member"; tailscaleLogin: string; deviceName: string | null };

export type ConnectionState = { status: "connecting" } | { status: "open" } | { status: "closed"; retryAt: number };

/** A thread belongs to one transcript. When the pane's claudeSessionId changes, the reducer drops the thread. */
export interface ChatThread {
  claudeSessionId: ClaudeSessionId;
  /** ts ascending, unique by uuid. Pages and pushes merge as a set union, so their arrival order does not matter. */
  events: readonly ChatEvent[];
  latestLoaded: boolean;
  loadingOlder: boolean;
  exhausted: boolean;
}

/**
 * Buttons render only while forSeq === session.stateChangeSeq and stay disabled after one answer for that seq.
 * This is the phone's half of the guard; the server's half re-reads the dialog and compares dialogId.
 */
export interface BlockedState {
  forSeq: number;
  dialog: BlockedDialog;
  answered: boolean;
}

/**
 * A prompt bubble the transcript has not echoed yet. It is never re-sent. `phase` holds facts only; what the bubble
 * says is pendingLabel's job at render time, so no timer ever writes to the store.
 */
export interface Pending {
  sessionId: SessionId;
  text: string;
  sentAt: number;
  /** delivered: herdr accepted it. failed: `error` says why; delivery_unconfirmed when the socket dropped mid-send. */
  phase: "sending" | "delivered" | "failed";
  error?: ErrorCode;
}

export type PendingLabel = "sending" | "queued" | "unconfirmed" | "failed";

const UNCONFIRMED_AFTER_MS = 10_000;

/**
 * failed → "failed" (the bubble shows ERROR_INFO[error].phone). delivered while the session is working → "queued":
 * Claude Code writes the user record only when it dequeues the message (spec 4.4). delivered, not working and older
 * than 10 s → "unconfirmed" ("Mac 화면을 확인하세요"). Otherwise "sending".
 */
export function pendingLabel(p: Pending, session: Session | undefined, now: number): PendingLabel {
  if (p.phase === "failed") return "failed";
  if (p.phase === "sending") return "sending";
  if (session?.status === "working") return "queued";
  return now - p.sentAt > UNCONFIRMED_AFTER_MS ? "unconfirmed" : "sending";
}

export interface AppState {
  me: MeState;
  connection: ConnectionState;
  /** null until the first sessions message, so a deep link shows a skeleton instead of "세션이 닫혔습니다". */
  sessions: { groups: readonly SessionGroup[]; byId: ReadonlyMap<SessionId, Session> } | null;
  /** When this phone saw each session's stateChangeSeq change (RelativeTime). */
  statusSince: ReadonlyMap<SessionId, number>;
  chat: ReadonlyMap<SessionId, ChatThread>;
  blocked: ReadonlyMap<SessionId, BlockedState>;
  /** Frame bytes never enter the store; xterm.ts holds the screen. */
  terminal: ReadonlyMap<SessionId, { width: number; height: number; state: TerminalState }>;
  pending: ReadonlyMap<RequestId, Pending>;
  /** Mirrored to localStorage so a 401 detour or a reload keeps the text. */
  drafts: ReadonlyMap<SessionId, string>;
  /** Slash commands per session, fetched once when the composer first sees a leading "/". */
  commands: ReadonlyMap<SessionId, readonly SlashCommand[]>;
  ui: { route: Route; tab: ReadonlyMap<SessionId, Tab>; termScale: "fit" | "native"; toast: string | null };
}

export type Action =
  | Exclude<ServerMessage, { type: "frame" }>
  | { type: "frame"; sessionId: SessionId; width: number; height: number }
  | { type: "me"; me: MeState }
  | { type: "connection"; connection: ConnectionState }
  | { type: "chat_page"; sessionId: SessionId; claudeSessionId: ClaudeSessionId; events: ChatEvent[]; limit: number; older: boolean }
  | { type: "chat_older_loading"; sessionId: SessionId; loading: boolean }
  | { type: "chat_reset"; sessionId: SessionId }
  | { type: "blocked"; sessionId: SessionId; forSeq: number; dialog: BlockedDialog }
  | { type: "blocked_answered"; sessionId: SessionId }
  | { type: "prompt_sent"; requestId: RequestId; sessionId: SessionId; text: string; at: number }
  | { type: "draft"; sessionId: SessionId; text: string }
  | { type: "commands"; sessionId: SessionId; commands: readonly SlashCommand[] }
  | { type: "route"; route: Route }
  | { type: "tab"; sessionId: SessionId; tab: Tab }
  | { type: "term_scale"; scale: "fit" | "native" }
  | { type: "toast"; text: string | null };

function mapSet<K, V>(m: ReadonlyMap<K, V>, key: K, value: V): Map<K, V> {
  return new Map(m).set(key, value);
}
/** The same map when the key is absent, so an unchanged map keeps its identity. */
function mapDelete<K, V>(m: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> {
  if (!m.has(key)) return m;
  const next = new Map(m);
  next.delete(key);
  return next;
}
function mapFilter<K, V>(m: ReadonlyMap<K, V>, keep: (value: V, key: K) => boolean): ReadonlyMap<K, V> {
  let next: Map<K, V> | null = null;
  for (const [key, value] of m) {
    if (keep(value, key)) continue;
    next ??= new Map(m);
    next.delete(key);
  }
  return next ?? m;
}

const newThread = (claudeSessionId: ClaudeSessionId): ChatThread => ({ claudeSessionId, events: [], latestLoaded: false, loadingOlder: false, exhausted: false });

const onScreen = (s: AppState, id: SessionId): boolean => s.ui.route.name === "session" && s.ui.route.sessionId === id;

function cutThread(t: ChatThread): ChatThread {
  return t.events.length > THREAD_CAP ? { ...t, events: t.events.slice(-THREAD_CAP), exhausted: false } : t;
}

function sameRoute(a: Route, b: Route): boolean {
  return a.name === b.name && (a.name !== "session" || b.name !== "session" || a.sessionId === b.sessionId);
}

function onSessions(s: AppState, a: Extract<Action, { type: "sessions" }>): AppState {
  const byId = new Map<SessionId, Session>(a.sessions.map((row) => [row.id, row]));
  const before = s.sessions?.byId;
  const now = Date.now();
  let statusSince = s.statusSince;
  if (before) {
    for (const [id, row] of byId) {
      const old = before.get(id);
      if (old && old.stateChangeSeq !== row.stateChangeSeq) statusSince = mapSet(statusSince, id, now);
    }
  }
  statusSince = mapFilter(statusSince, (_, id) => byId.has(id));
  return {
    ...s,
    sessions: { groups: a.groups, byId },
    statusSince,
    chat: mapFilter(s.chat, (t, id) => byId.get(id)?.claudeSessionId === t.claudeSessionId),
    blocked: mapFilter(s.blocked, (_, id) => byId.get(id)?.status === "blocked"),
  };
}

function onChat(s: AppState, a: Extract<Action, { type: "chat" }>): AppState {
  const claudeSessionId = s.sessions?.byId.get(a.sessionId)?.claudeSessionId;
  if (!claudeSessionId) return s;
  const existing = s.chat.get(a.sessionId);
  const thread = existing && existing.claudeSessionId === claudeSessionId ? existing : newThread(claudeSessionId);
  const known = new Set(thread.events.map((e) => e.uuid));
  const events = mergeEvents(thread.events, a.events);
  if (existing === thread && events === thread.events) return s;

  let pending = s.pending;
  let drafts = s.drafts;
  for (const event of a.events) {
    if (event.kind !== "user_text" || known.has(event.uuid)) continue;
    known.add(event.uuid);
    for (const [requestId, p] of pending) {
      if (p.sessionId !== a.sessionId || !echoMatches(p.text, event.text)) continue;
      pending = mapDelete(pending, requestId);
      // The echo proves delivery, so a draft that still holds this text (a failed or unanswered send) is spent.
      if (drafts.get(a.sessionId)?.trim() === p.text) drafts = mapDelete(drafts, a.sessionId);
      break;
    }
  }

  const merged = { ...thread, events };
  return { ...s, chat: mapSet(s.chat, a.sessionId, onScreen(s, a.sessionId) ? merged : cutThread(merged)), pending, drafts };
}

function onChatPage(s: AppState, a: Extract<Action, { type: "chat_page" }>): AppState {
  if (s.sessions?.byId.get(a.sessionId)?.claudeSessionId !== a.claudeSessionId) return s;
  const existing = s.chat.get(a.sessionId);
  if (existing && existing.claudeSessionId !== a.claudeSessionId) return s;
  const thread = existing ?? newThread(a.claudeSessionId);
  const events = mergeEvents(thread.events, a.events);
  const short = a.events.length < a.limit;
  const next: ChatThread = a.older
    ? { ...thread, events, loadingOlder: false, exhausted: short }
    : { ...thread, events, latestLoaded: true, exhausted: thread.exhausted || short };
  return { ...s, chat: mapSet(s.chat, a.sessionId, next) };
}

function onCommandResult(s: AppState, a: Extract<Action, { type: "command_result" }>): AppState {
  const p = s.pending.get(a.requestId);
  if (p) {
    // A slash command runs inside Claude Code and may never reach the transcript (/cost, measured), so herdr's
    // acceptance is its whole story; a prompt stays pending until its echo arrives.
    if (a.ok && p.text.startsWith("/")) return { ...s, pending: mapDelete(s.pending, a.requestId), drafts: mapDelete(s.drafts, p.sessionId) };
    const next: Pending = a.ok ? { ...p, phase: "delivered" } : { ...p, phase: "failed", error: a.error };
    return { ...s, pending: mapSet(s.pending, a.requestId, next), drafts: a.ok ? mapDelete(s.drafts, p.sessionId) : s.drafts };
  }
  if (a.ok) return s;
  // command_result names no session, so a stale_dialog answer drops every dialog that was already answered.
  const blocked = a.error === "stale_dialog" ? mapFilter(s.blocked, (b) => !b.answered) : s.blocked;
  return { ...s, blocked, ui: { ...s.ui, toast: ERROR_INFO[a.error].phone } };
}

function onConnection(s: AppState, c: ConnectionState): AppState {
  if (c.status === s.connection.status && (c.status !== "closed" || (s.connection.status === "closed" && s.connection.retryAt === c.retryAt))) return s;
  let { pending, chat } = s;
  if (c.status === "closed") {
    for (const [requestId, p] of pending) {
      if (p.phase === "sending") pending = mapSet(pending, requestId, { ...p, phase: "failed", error: "delivery_unconfirmed" });
    }
  }
  // Pushes sent while the socket was down never arrive, so a thread kept across the gap would have a hole in it.
  if (c.status === "open" && s.connection.status === "closed") chat = new Map();
  return { ...s, connection: c, pending, chat };
}

function onMe(s: AppState, me: MeState): AppState {
  if (me.status !== "anonymous") return { ...s, me };
  // Everything the server sent belongs to the login that just ended. Drafts stay: a 401 detour keeps the text.
  return { ...s, me, sessions: null, statusSince: new Map(), chat: new Map(), blocked: new Map(), terminal: new Map(), pending: new Map() };
}

function onRoute(s: AppState, route: Route): AppState {
  const left = s.ui.route;
  if (sameRoute(left, route)) return s;
  let chat = s.chat;
  const thread = left.name === "session" ? chat.get(left.sessionId) : undefined;
  if (left.name === "session" && thread) {
    const cut = cutThread(thread);
    if (cut !== thread) chat = mapSet(chat, left.sessionId, cut);
  }
  return { ...s, chat, ui: { ...s.ui, route } };
}

/**
 * Pure apart from `Date.now()` in `sessions`, which stamps statusSince; returns `s` itself when nothing changed, so
 * the signal does not notify (most frames change nothing here). The actions beyond the ServerMessage ones are
 * chat_reset (drop a thread after stale_cursor) and the `me` clean-up on logout.
 */
export function reduce(s: AppState, a: Action): AppState {
  switch (a.type) {
    case "me":
      return onMe(s, a.me);
    case "connection":
      return onConnection(s, a.connection);
    case "sessions":
      return onSessions(s, a);
    case "chat":
      return onChat(s, a);
    case "chat_page":
      return onChatPage(s, a);
    case "chat_older_loading": {
      const thread = s.chat.get(a.sessionId);
      if (!thread || thread.loadingOlder === a.loading) return s;
      return { ...s, chat: mapSet(s.chat, a.sessionId, { ...thread, loadingOlder: a.loading }) };
    }
    case "chat_reset":
      return { ...s, chat: mapDelete(s.chat, a.sessionId) };
    case "blocked": {
      const old = s.blocked.get(a.sessionId);
      // The re-read after an answer finds the same dialog while herdr is still processing it: stay answered.
      if (old?.answered && old.forSeq === a.forSeq && old.dialog.dialogId === a.dialog.dialogId) return s;
      return { ...s, blocked: mapSet(s.blocked, a.sessionId, { forSeq: a.forSeq, dialog: a.dialog, answered: false }) };
    }
    case "blocked_answered": {
      const old = s.blocked.get(a.sessionId);
      if (!old || old.answered) return s;
      return { ...s, blocked: mapSet(s.blocked, a.sessionId, { ...old, answered: true }) };
    }
    case "command_result":
      return onCommandResult(s, a);
    case "prompt_sent": {
      const pending = new Map(mapFilter(s.pending, (p) => !(p.sessionId === a.sessionId && p.phase === "failed")));
      pending.set(a.requestId, { sessionId: a.sessionId, text: a.text, sentAt: a.at, phase: "sending" });
      return { ...s, pending };
    }
    case "commands":
      return { ...s, commands: mapSet(s.commands, a.sessionId, a.commands) };
    case "draft": {
      if ((s.drafts.get(a.sessionId) ?? "") === a.text) return s;
      return { ...s, drafts: a.text === "" ? mapDelete(s.drafts, a.sessionId) : mapSet(s.drafts, a.sessionId, a.text) };
    }
    case "route":
      return onRoute(s, a.route);
    case "tab":
      return s.ui.tab.get(a.sessionId) === a.tab ? s : { ...s, ui: { ...s.ui, tab: mapSet(s.ui.tab, a.sessionId, a.tab) } };
    case "term_scale":
      return s.ui.termScale === a.scale ? s : { ...s, ui: { ...s.ui, termScale: a.scale } };
    case "toast":
      return s.ui.toast === a.text ? s : { ...s, ui: { ...s.ui, toast: a.text } };
    case "terminal_status": {
      const old = s.terminal.get(a.sessionId);
      if (old?.state === a.state) return s;
      return { ...s, terminal: mapSet(s.terminal, a.sessionId, { width: old?.width ?? 0, height: old?.height ?? 0, state: a.state }) };
    }
    case "frame": {
      const old = s.terminal.get(a.sessionId);
      if (old && old.width === a.width && old.height === a.height) return s;
      return { ...s, terminal: mapSet(s.terminal, a.sessionId, { width: a.width, height: a.height, state: old?.state ?? "live" }) };
    }
    default: {
      const unknown: never = a;
      void unknown;
      return s;
    }
  }
}

const DRAFTS_KEY = "console.drafts";

/** Drafts are the only thing kept in localStorage. Never a token or a passphrase. */
function loadDrafts(): ReadonlyMap<SessionId, string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? "{}");
    if (typeof raw !== "object" || raw === null) return new Map();
    return new Map(Object.entries(raw).filter((e): e is [SessionId, string] => typeof e[1] === "string" && e[1] !== ""));
  } catch {
    return new Map();
  }
}

function saveDrafts(drafts: ReadonlyMap<SessionId, string>): void {
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(Object.fromEntries(drafts)));
  } catch {
    // Private mode or a full quota: the draft then lives only in memory.
  }
}

/** The route starts as "sessions"; boot reads the address bar. Nothing renders before boot has answered. */
function initialState(): AppState {
  return {
    me: { status: "loading" },
    connection: { status: "connecting" },
    sessions: null,
    statusSince: new Map(),
    chat: new Map(),
    blocked: new Map(),
    commands: new Map(),
    terminal: new Map(),
    pending: new Map(),
    drafts: loadDrafts(),
    ui: { route: { name: "sessions" }, tab: new Map(), termScale: "fit", toast: null },
  };
}

export const state = signal<AppState>(initialState());

export function dispatch(a: Action): void {
  const prev = state.value;
  const next = reduce(prev, a);
  if (next === prev) return;
  if (next.drafts !== prev.drafts) saveDrafts(next.drafts);
  state.value = next;
}

const NOT_CONNECTED = "연결이 끊겨 있어 보내지 못했습니다. 연결되면 다시 보내세요.";
const toast = (text: string) => dispatch({ type: "toast", text });
const newRequestId = () => crypto.randomUUID() as RequestId;

/** GET /api/me → me; member → connect(); anonymous → login with `next` kept. */
export async function boot(): Promise<void> {
  startRouter();
  const retryMs = 2000;
  let me = await api("GET /api/me", {});
  while (!me) {
    await new Promise((resolve) => setTimeout(resolve, retryMs));
    me = await api("GET /api/me", {});
  }
  const { tailscaleLogin, deviceName } = me;
  if (me.loggedIn) {
    dispatch({ type: "me", me: { status: "member", tailscaleLogin, deviceName } });
    if (state.value.ui.route.name === "login") navigate({ name: "sessions" }, { replace: true });
    connect();
    return;
  }
  const next = location.pathname === "/login" ? "/" : location.pathname;
  dispatch({ type: "me", me: { status: "anonymous", tailscaleLogin, deviceName, next } });
  navigate({ name: "login" }, { replace: true });
}

/** The 401 path of api() and of the socket (close code 4401): drop to the login screen, remembering where the user was. */
export function expireSession(next = state.value.ui.route.name === "login" ? "/" : location.pathname): void {
  disconnect();
  const me = state.value.me;
  if (me.status !== "member") return;
  dispatch({ type: "me", me: { status: "anonymous", tailscaleLogin: me.tailscaleLogin, deviceName: me.deviceName, next } });
  navigate({ name: "login" }, { replace: true });
}

/**
 * The reply carries what the login screen shows (remaining attempts, retry_after), so it is returned rather than
 * stored. null means the call failed and api() already said so. On success this goes on to the remembered path.
 */
export async function login(passphrase: string): Promise<LoginReply | null> {
  const reply = await api("POST /api/login", { body: { passphrase } });
  const me = state.value.me;
  if (reply && "ok" in reply && me.status === "anonymous") {
    dispatch({ type: "me", me: { status: "member", tailscaleLogin: me.tailscaleLogin, deviceName: me.deviceName } });
    navigate(parseRoute(me.next), { replace: true });
    connect();
  }
  return reply;
}

export async function logout(scope: "this" | "all"): Promise<void> {
  const done = await api("POST /api/logout", { body: { all: scope === "all" } });
  if (done) expireSession("/");
}

const openingChat = new Set<SessionId>();

/** Fetches the newest page once per thread; later events arrive by push. stale_cursor drops the thread and fetches again. */
export async function openChat(sessionId: SessionId): Promise<void> {
  const claudeSessionId = state.value.sessions?.byId.get(sessionId)?.claudeSessionId;
  if (!claudeSessionId || state.value.chat.get(sessionId)?.latestLoaded || openingChat.has(sessionId)) return;
  openingChat.add(sessionId);
  try {
    const events = await api("GET /api/sessions/:id/chat", { id: sessionId, query: { limit: CHAT_PAGE } });
    if (events) dispatch({ type: "chat_page", sessionId, claudeSessionId, events, limit: CHAT_PAGE, older: false });
  } finally {
    openingChat.delete(sessionId);
  }
}

/** Single flight per thread through loadingOlder; a short page sets exhausted. */
export async function loadOlder(sessionId: SessionId): Promise<void> {
  const thread = state.value.chat.get(sessionId);
  if (!thread || thread.exhausted || thread.loadingOlder) return;
  dispatch({ type: "chat_older_loading", sessionId, loading: true });
  const events = await api("GET /api/sessions/:id/chat", { id: sessionId, query: { before: thread.events[0]?.uuid, limit: CHAT_PAGE } });
  if (!events) return dispatch({ type: "chat_older_loading", sessionId, loading: false });
  dispatch({ type: "chat_page", sessionId, claudeSessionId: thread.claudeSessionId, events, limit: CHAT_PAGE, older: true });
}

/** Fetches the dialog for this stateChangeSeq. After an answer, fetches once more at 800 ms: a new text in the same seq is a new dialog. */
export async function loadBlocked(sessionId: SessionId, forSeq: number): Promise<void> {
  const dialog = await api("GET /api/sessions/:id/blocked", { id: sessionId });
  if (dialog) dispatch({ type: "blocked", sessionId, forSeq, dialog });
}

const loadingCommands = new Set<SessionId>();

/** Once per session per page load; the list changes only when files on the Mac change. */
export async function loadCommands(sessionId: SessionId): Promise<void> {
  if (state.value.commands.has(sessionId) || loadingCommands.has(sessionId)) return;
  loadingCommands.add(sessionId);
  try {
    const commands = await api("GET /api/sessions/:id/commands", { id: sessionId });
    if (commands) dispatch({ type: "commands", sessionId, commands });
  } finally {
    loadingCommands.delete(sessionId);
  }
}

const REREAD_DIALOG_MS = 800;

/** requestId = crypto.randomUUID(). Not connected → toast, no pending bubble. */
export function sendPrompt(sessionId: SessionId, text: string): void {
  const requestId = newRequestId();
  if (!sendCommand({ type: "prompt", requestId, sessionId, text })) return toast(NOT_CONNECTED);
  dispatch({ type: "prompt_sent", requestId, sessionId, text, at: Date.now() });
}

/** A dialog button passes the dialogId it rendered from, so the server can refuse a dialog that changed since. */
export function sendKeys(sessionId: SessionId, keys: string[], guard?: { dialogId: string }): void {
  if (!sendCommand({ type: "keys", requestId: newRequestId(), sessionId, keys, guard })) return toast(NOT_CONNECTED);
  if (!guard) return;
  const forSeq = state.value.blocked.get(sessionId)?.forSeq;
  dispatch({ type: "blocked_answered", sessionId });
  if (forSeq === undefined) return;
  setTimeout(() => {
    const now = state.value.sessions?.byId.get(sessionId);
    if (now?.status === "blocked" && now.stateChangeSeq === forSeq) void loadBlocked(sessionId, forSeq);
  }, REREAD_DIALOG_MS);
}

export function sendRawText(sessionId: SessionId, text: string): void {
  if (!sendCommand({ type: "raw_text", requestId: newRequestId(), sessionId, text })) toast(NOT_CONNECTED);
}

export function watchTerminal(sessionId: SessionId): void {
  sendCommand({ type: "watch_terminal", requestId: newRequestId(), sessionId });
}

export function unwatchTerminal(sessionId: SessionId): void {
  sendCommand({ type: "unwatch_terminal", requestId: newRequestId(), sessionId });
}
