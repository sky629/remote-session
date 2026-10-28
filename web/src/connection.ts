import type { SessionId, TerminalFrame } from "#shared/domain";
import type { Command } from "#shared/protocol";

/**
 * The single WS. Every server message goes through dispatch; a frame's bytes go to frameBus and only its size reaches
 * the store. On close it asks GET /api/me before retrying: a failed upgrade hides its HTTP status, so this tells a 401
 * from a network drop, and close code 4401 (logged out) goes straight to login. Backoff 1 s doubling to 15 s, reset
 * when the page becomes visible again (iOS suspends sockets on lock). Commands are never queued or re-sent.
 */
export function connect(): void {
  throw new Error("not implemented");
}

/** false when the socket is not open; the caller shows a toast and keeps the draft. */
export function sendCommand(cmd: Command): boolean {
  throw new Error("not implemented");
}

/** Frame bytes bypass the store. TerminalView subscribes before it sends watch_terminal, so the first full frame is never missed. */
export interface FrameBus {
  subscribe(sessionId: SessionId, fn: (frame: TerminalFrame) => void): () => void;
  publish(sessionId: SessionId, frame: TerminalFrame): void;
}
export const frameBus: FrameBus = undefined as never; // TODO Map<SessionId, Set<fn>>
