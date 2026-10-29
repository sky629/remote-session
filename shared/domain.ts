/**
 * Domain types shared by server and web (spec 6). Erasable TypeScript only: the server runs this file
 * through Node's type stripping, and tsconfig's erasableSyntaxOnly rejects anything it cannot strip.
 */

declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export const SOURCE_KINDS = ["herdr", "cmux"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** `${source}:${group}/${paneId}`, e.g. "herdr:default/w11:p1". Unique across sources and groups. */
export type SessionId = Brand<string, "SessionId">;
/** Claude Code session id (lowercase UUID). It becomes a file name, so only parseClaudeSessionId mints it. */
export type ClaudeSessionId = Brand<string, "ClaudeSessionId">;

/** What a source knows about one pane (spec 6.1). Every field is a primitive, so rows compare field by field. */
export interface SessionFacts {
  id: SessionId;
  source: SourceKind;
  /** Group inside the source. For herdr it is the herdr session name ("default", "rocket"). */
  group: string;
  paneId: string;
  terminalId: string;
  workspaceLabel: string;
  title: string | null;
  cwd: string | null;
  /** null for a pane without an agent. Its status is then "unknown". */
  agent: string | null;
  claudeSessionId: ClaudeSessionId | null;
  /** 0 for panes without an agent (herdr's panes[] carries no state_change_seq; measured). */
  stateChangeSeq: number;
}

/** A row of an unreachable group can only say "unknown". Any other pairing is a type error. */
export type Liveness = { reachable: true; status: AgentStatus } | { reachable: false; status: "unknown" };

/** One list row. The registry adds transcriptPath, non-null exactly when the transcript file exists. */
export type Session = SessionFacts & Liveness & { transcriptPath: string | null };

/** Listed even with no panes, so an empty herdr session ("rocket") still shows as a group (spec 7.1). */
export interface SessionGroup {
  source: SourceKind;
  name: string;
  reachable: boolean;
}

/** Always sent and replaced whole, never patched (spec 7.1). */
export interface SessionList {
  groups: readonly SessionGroup[];
  sessions: readonly Session[];
}

export function makeSessionId(source: SourceKind, group: string, paneId: string): SessionId {
  return `${source}:${group}/${paneId}` as SessionId;
}

const SESSION_ID = new RegExp(`^(${SOURCE_KINDS.join("|")}):([^/]+)/([^/]+)$`);

/** Parses untrusted ids (URL paths, WS commands). Neither group names nor pane ids contain "/". */
export function parseSessionId(raw: string): { id: SessionId; source: SourceKind; group: string; paneId: string } | null {
  const m = SESSION_ID.exec(raw);
  if (!m) return null;
  return { id: raw as SessionId, source: m[1] as SourceKind, group: m[2]!, paneId: m[3]! };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseClaudeSessionId(raw: unknown): ClaudeSessionId | null {
  return typeof raw === "string" && UUID.test(raw) ? (raw as ClaudeSessionId) : null;
}

/**
 * One piece of conversation from the Claude transcript (spec 6.3). `uuid` is the record's uuid; a record that
 * yields several events gives its later ones `${uuid}#${index}`, so ids stay unique. Order is `ts` ascending.
 */
export type ChatEvent =
  | { kind: "user_text"; uuid: string; ts: string; text: string }
  | { kind: "assistant_text"; uuid: string; ts: string; text: string }
  /** `path`: the absolute file a writing tool (Write, Edit, MultiEdit, NotebookEdit) targeted; absent for other tools. */
  | { kind: "tool_use"; uuid: string; ts: string; toolUseId: string; name: string; summary: string; path?: string }
  | { kind: "tool_result"; uuid: string; ts: string; toolUseId: string; isError: boolean; preview: string };

/** herdr's terminal.frame minus `type` and `encoding` (spec 6.4). `bytes` stays base64; the server never decodes it. */
export interface TerminalFrame {
  seq: number;
  full: boolean;
  width: number;
  height: number;
  bytes: string;
}

/** `key` is the digit printed on the same line as `label`, never a position guessed by the parser. */
export interface BlockedOption {
  key: string;
  label: string;
}

/**
 * GET /api/sessions/:id/blocked. `options` is empty when the dialog was not recognized; the phone then shows the
 * dialog presets of KEY_PRESETS beside `text`. `dialogId` hashes the normalized text, and a button press sends it
 * back as `keys.guard` so the server can refuse a dialog that changed after the phone read it.
 */
export interface BlockedDialog {
  text: string;
  options: BlockedOption[];
  dialogId: string;
}
