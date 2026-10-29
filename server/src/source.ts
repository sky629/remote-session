import type { Liveness, Session, SessionFacts, SessionGroup, SourceKind, TerminalFrame } from "#shared/domain";
import type { Result } from "#shared/errors";
import type { InputCommand, TerminalState } from "#shared/protocol";

/** A row as a source reports it. The registry adds transcriptPath: transcripts are Claude knowledge, not source knowledge. */
export type SourceSession = SessionFacts & Liveness;

export interface SourcePoll {
  groups: SessionGroup[];
  sessions: SourceSession[];
}

/** Receives one terminal stream. "live" follows the first frame of each (re)start; "ended" means the terminal is gone. */
export interface TerminalSink {
  frame(frame: TerminalFrame): void;
  status(state: TerminalState): void;
}

export interface TerminalObservation {
  /** Restart the stream so the next frame is full. Used for "watch twice" and for a client that fell behind. */
  resync(): void;
  /** Idempotent. Stops the child process; the sink gets no calls after this returns. */
  close(): void;
}

/**
 * The adapter boundary. Everything specific to one terminal host lives behind it: sockets, wire formats, pane
 * geometry, observer processes, error codes. Registry, hub and UI see domain types and Result only, so a cmux
 * adapter is one new implementation plus one entry in main.ts. No method rejects.
 */
export interface SessionSource {
  readonly kind: SourceKind;
  /** Every group and row this source knows. An unreachable group returns its last-known rows as reachable:false. */
  poll(): Promise<SourcePoll>;
  /**
   * prompt: submit text with Enter. keys: key names. raw_text: bytes without Enter. Never retried here or above.
   * A reply lost after the write is delivery_unconfirmed, never source_unreachable, because the input may have landed.
   */
  send(session: Session, input: InputCommand): Promise<Result>;
  /** The plain text the source recognizes the agent's dialog from (herdr: the detection read source). */
  readDialog(session: Session): Promise<Result<{ text: string }>>;
  /** Frames at the pane's real size. The adapter follows resizes and restarts after crashes until close(). */
  observeTerminal(session: Session, sink: TerminalSink): TerminalObservation;
  /** Ends every socket and child process. */
  close(): Promise<void>;
}

export type SourceTable = Partial<Record<SourceKind, SessionSource>>;
