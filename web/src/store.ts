import { signal } from "@preact/signals";
import type { BlockedDialog, ChatEvent, ClaudeSessionId, Session, SessionGroup, SessionId } from "#shared/domain";
import type { ErrorCode } from "#shared/errors";
import type { RequestId, ServerMessage, TerminalState } from "#shared/protocol";

export type Tab = "chat" | "term";
export type Route = { name: "login" } | { name: "sessions" } | { name: "session"; sessionId: SessionId };

/** A thread not on screen keeps only its newest THREAD_CAP events (spec 6.6); scrolling up later fetches the rest again. */
export const THREAD_CAP = 500;

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

/**
 * failed → "failed" (the bubble shows ERROR_INFO[error].phone). delivered while the session is working → "queued":
 * Claude Code writes the user record only when it dequeues the message (spec 4.4). delivered, not working and older
 * than 10 s → "unconfirmed" ("Mac 화면을 확인하세요"). Otherwise "sending".
 */
export function pendingLabel(p: Pending, session: Session | undefined, now: number): PendingLabel {
  throw new Error("not implemented");
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
  ui: { route: Route; tab: ReadonlyMap<SessionId, Tab>; termScale: "fit" | "native"; toast: string | null };
}

export type Action =
  | Exclude<ServerMessage, { type: "frame" }>
  | { type: "frame"; sessionId: SessionId; width: number; height: number }
  | { type: "me"; me: MeState }
  | { type: "connection"; connection: ConnectionState }
  | { type: "chat_page"; sessionId: SessionId; claudeSessionId: ClaudeSessionId; events: ChatEvent[]; limit: number; older: boolean }
  | { type: "chat_older_loading"; sessionId: SessionId; loading: boolean }
  | { type: "blocked"; sessionId: SessionId; forSeq: number; dialog: BlockedDialog }
  | { type: "blocked_answered"; sessionId: SessionId }
  | { type: "prompt_sent"; requestId: RequestId; sessionId: SessionId; text: string; at: number }
  | { type: "draft"; sessionId: SessionId; text: string }
  | { type: "route"; route: Route }
  | { type: "tab"; sessionId: SessionId; tab: Tab }
  | { type: "term_scale"; scale: "fit" | "native" }
  | { type: "toast"; text: string | null };

/**
 * Pure. Returns `s` itself when nothing changed, so the signal does not notify (most frames change nothing here).
 * TODO by action:
 *   sessions         replace groups and byId; statusSince[id] = now where stateChangeSeq moved; drop chat threads whose
 *                    session is gone or whose claudeSessionId differs; drop blocked entries whose session left "blocked"
 *   chat             ignore unless byId.get(id)?.claudeSessionId is set; create the thread (latestLoaded false) if absent;
 *                    events = mergeEvents(thread.events, a.events); each user_text deletes the oldest pending of that
 *                    session with echoMatches(pending.text, event.text); a thread not on screen is cut to THREAD_CAP
 *                    newest events and its exhausted flag cleared
 *   chat_page        ignore unless thread.claudeSessionId === a.claudeSessionId; merge; older → exhausted = events < limit,
 *                    loadingOlder = false; latest → latestLoaded = true (exhausted too when short). Pages never reconcile pending.
 *   command_result   pending → ok: phase "delivered", drafts.delete(sessionId); error: phase "failed" with the code, draft kept
 *                    other commands → toast ERROR_INFO[error].phone on error; stale_dialog also drops blocked[id] so it reloads
 *   prompt_sent      also deletes that session's failed bubbles: the new send replaces them
 *   connection       closed → every "sending" pending becomes failed with delivery_unconfirmed
 *   route            leaving a session cuts its thread to THREAD_CAP
 *   terminal_status  terminal[id].state = a.state
 *   frame            size unchanged → return s
 */
export function reduce(s: AppState, a: Action): AppState {
  throw new Error("not implemented");
}

export const state = signal<AppState>(undefined as never); // TODO initial state; drafts read from localStorage in try/catch
export function dispatch(a: Action): void {
  state.value = reduce(state.value, a);
}

/** GET /api/me → me; member → connect(); anonymous → login with `next` kept. */
export async function boot(): Promise<void> {
  throw new Error("not implemented");
}
export async function login(passphrase: string): Promise<void> {
  throw new Error("not implemented");
}
export async function logout(scope: "this" | "all"): Promise<void> {
  throw new Error("not implemented");
}
/** Fetches the newest page once per thread; later events arrive by push. stale_cursor drops the thread and fetches again. */
export async function openChat(sessionId: SessionId): Promise<void> {
  throw new Error("not implemented");
}
/** Single flight per thread through loadingOlder; a short page sets exhausted. */
export async function loadOlder(sessionId: SessionId): Promise<void> {
  throw new Error("not implemented");
}
/** Fetches the dialog for this stateChangeSeq. After an answer, fetches once more at 800 ms: a new text in the same seq is a new dialog. */
export async function loadBlocked(sessionId: SessionId, forSeq: number): Promise<void> {
  throw new Error("not implemented");
}
/** requestId = crypto.randomUUID(). Not connected → toast, no pending bubble. */
export function sendPrompt(sessionId: SessionId, text: string): void {
  throw new Error("not implemented");
}
/** A dialog button passes the dialogId it rendered from, so the server can refuse a dialog that changed since. */
export function sendKeys(sessionId: SessionId, keys: string[], guard?: { dialogId: string }): void {
  throw new Error("not implemented");
}
export function sendRawText(sessionId: SessionId, text: string): void {
  throw new Error("not implemented");
}
export function watchTerminal(sessionId: SessionId): void {
  throw new Error("not implemented");
}
export function unwatchTerminal(sessionId: SessionId): void {
  throw new Error("not implemented");
}
