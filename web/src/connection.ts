import type { SessionId, TerminalFrame } from "#shared/domain";
import type { Command, ServerMessage } from "#shared/protocol";
import { api } from "./api.ts";
import { dispatch, expireSession } from "./store.ts";

const BACKOFF_FIRST_MS = 1000;
const BACKOFF_MAX_MS = 15_000;
/** iOS suspends sockets while the page is hidden and may not report it, so a long absence reopens the socket. */
const STALE_AFTER_HIDDEN_MS = 10_000;
const CLOSE_LOGGED_OUT = 4401;

let socket: WebSocket | null = null;
let wanted = false;
let attempt = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let hiddenAt = 0;
let watchingVisibility = false;

/**
 * The single WS. Every server message goes through dispatch; a frame's bytes go to frameBus and only its size reaches
 * the store. On close it asks GET /api/me before retrying: a failed upgrade hides its HTTP status, so this tells a 401
 * from a network drop, and close code 4401 (logged out) goes straight to login. Backoff 1 s doubling to 15 s, reset
 * when the page becomes visible again (iOS suspends sockets on lock). Commands are never queued or re-sent.
 */
export function connect(): void {
  wanted = true;
  if (!watchingVisibility) {
    watchingVisibility = true;
    document.addEventListener("visibilitychange", onVisibility);
  }
  open();
}

export function disconnect(): void {
  wanted = false;
  clearTimeout(timer);
  const old = socket;
  socket = null;
  old?.close();
}

/** false when the socket is not open; the caller shows a toast and keeps the draft. */
export function sendCommand(cmd: Command): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(cmd));
  return true;
}

function open(): void {
  if (!wanted || socket) return;
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  socket = ws;
  ws.onopen = () => {
    attempt = 0;
    dispatch({ type: "connection", connection: { status: "open" } });
  };
  ws.onmessage = (ev) => receive(String(ev.data));
  ws.onclose = (ev) => {
    if (socket !== ws) return;
    socket = null;
    if (!wanted) return;
    if (ev.code === CLOSE_LOGGED_OUT) expireSession();
    else scheduleRetry(Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** attempt++));
  };
}

function receive(raw: string): void {
  let msg: ServerMessage;
  try {
    msg = JSON.parse(raw) as ServerMessage;
  } catch {
    return;
  }
  if (msg.type === "frame") {
    frameBus.publish(msg.sessionId, msg.frame);
    dispatch({ type: "frame", sessionId: msg.sessionId, width: msg.frame.width, height: msg.frame.height });
  } else {
    dispatch(msg);
  }
}

function scheduleRetry(delayMs: number): void {
  clearTimeout(timer);
  dispatch({ type: "connection", connection: { status: "closed", retryAt: Date.now() + delayMs } });
  timer = setTimeout(() => void retry(), delayMs);
}

async function retry(): Promise<void> {
  const me = await api("GET /api/me", {});
  if (!wanted) return;
  if (!me) return scheduleRetry(Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** attempt++));
  if (!me.loggedIn) return expireSession();
  open();
}

function onVisibility(): void {
  if (document.visibilityState === "hidden") {
    hiddenAt = Date.now();
    return;
  }
  if (!wanted) return;
  const stale = socket !== null && Date.now() - hiddenAt > STALE_AFTER_HIDDEN_MS;
  if (socket && !stale) return;
  attempt = 0;
  const old = socket;
  socket = null;
  old?.close();
  scheduleRetry(0);
}

/** Frame bytes bypass the store. TerminalView subscribes before it sends watch_terminal, so the first full frame is never missed. */
export interface FrameBus {
  subscribe(sessionId: SessionId, fn: (frame: TerminalFrame) => void): () => void;
  publish(sessionId: SessionId, frame: TerminalFrame): void;
}

const listeners = new Map<SessionId, Set<(frame: TerminalFrame) => void>>();

export const frameBus: FrameBus = {
  subscribe(sessionId, fn) {
    const set = listeners.get(sessionId) ?? new Set();
    listeners.set(sessionId, set.add(fn));
    return () => {
      set.delete(fn);
      if (set.size === 0 && listeners.get(sessionId) === set) listeners.delete(sessionId);
    };
  },
  publish(sessionId, frame) {
    for (const fn of listeners.get(sessionId) ?? []) fn(frame);
  },
};
