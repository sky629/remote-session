import { z } from "zod";
import { parseSessionId } from "./domain.ts";
import type { BlockedDialog, Brand, ChatEvent, Session, SessionId, SessionList, TerminalFrame } from "./domain.ts";
import type { Result } from "./errors.ts";
import { HERDR_KEY } from "./keys.ts";

/** Made by the phone, one per command. The hub remembers it for 2 minutes, so a resend never reaches herdr twice. */
export type RequestId = Brand<string, "RequestId">;

export const LIMITS = { textChars: 100_000, keys: 16, pageDefault: 50, pageMax: 200 } as const;

const RequestIdField = z.custom<RequestId>((v) => typeof v === "string" && /^[\w-]{8,64}$/.test(v));
const SessionIdField = z.custom<SessionId>((v) => typeof v === "string" && parseSessionId(v) !== null);
const command = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ type: z.literal(type), requestId: RequestIdField, sessionId: SessionIdField, ...shape });

/**
 * Phone to server over WS: spec 6.6 plus requestId. The single source of the Command type, the server's validation
 * and the length limits. `guard` makes the server re-read the dialog right before sending and refuse a changed one.
 */
export const CommandSchema = z.discriminatedUnion("type", [
  command("prompt", { text: z.string().min(1).max(LIMITS.textChars) }),
  command("keys", {
    keys: z.array(z.string().regex(HERDR_KEY)).min(1).max(LIMITS.keys),
    guard: z.object({ dialogId: z.string().min(1).max(64) }).optional(),
  }),
  command("raw_text", { text: z.string().min(1).max(LIMITS.textChars) }),
  command("watch_terminal", {}),
  command("unwatch_terminal", {}),
]);
export type Command = z.infer<typeof CommandSchema>;

/** The commands a source delivers to an agent. */
export type InputCommand = Extract<Command, { type: "prompt" | "keys" | "raw_text" }>;

/** JSON.parse and CommandSchema.safeParse. A failure keeps a readable requestId so the hub can answer invalid_command. */
export function parseCommand(raw: string): { ok: true; command: Command } | { ok: false; requestId: RequestId | null } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, requestId: null };
  }
  const parsed = CommandSchema.safeParse(json);
  if (parsed.success) return { ok: true, command: parsed.data };
  const id = typeof json === "object" && json !== null ? (json as { requestId?: unknown }).requestId : undefined;
  const requestId = RequestIdField.safeParse(id);
  return { ok: false, requestId: requestId.success ? requestId.data : null };
}

export type TerminalState = "live" | "restarting" | "ended";

/** Server to phone over WS (spec 7.1). */
export type ServerMessage =
  /** The whole list, sent on attach and whenever anything differs. The phone replaces, never patches. */
  | ({ type: "sessions" } & SessionList)
  /** Events appended to that session's transcript, in file order. Sent to every client. */
  | { type: "chat"; sessionId: SessionId; events: ChatEvent[] }
  | { type: "frame"; sessionId: SessionId; frame: TerminalFrame }
  /** Frames arrive only on change, so without this the phone cannot tell a dead stream from a quiet screen. */
  | { type: "terminal_status"; sessionId: SessionId; state: TerminalState }
  | ({ type: "command_result"; requestId: RequestId } & Result);

export const LoginBody = z.object({ passphrase: z.string().min(1).max(1024) });
export const LogoutBody = z.object({ all: z.boolean() });
export const ChatQuery = z.object({
  before: z.string().min(1).max(80).optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.pageMax).default(LIMITS.pageDefault),
});

export interface Me {
  loggedIn: boolean;
  tailscaleLogin: string;
  /** From `tailscale whois`; null when it could not be found. */
  deviceName: string | null;
}
export interface LoginRecord {
  ts: string;
  ok: boolean;
  tailscaleLogin: string;
  device: string;
}
/** The 401 and 429 bodies are data the login screen shows (spec 8.0), not generic errors. */
export type LoginReply =
  | { ok: true }
  | { error: "wrong_passphrase"; remaining: number }
  | { error: "rate_limited"; retry_after: number };

/**
 * Every HTTP route (spec 7.1). `req` and `query` are zod schema types: the server's route table must carry exactly
 * that schema and parses with it before the handler runs, and the web derives its call arguments from the same entry.
 */
export interface ApiContract {
  "GET /api/me": { res: Me };
  "POST /api/login": { req: typeof LoginBody; res: LoginReply };
  "POST /api/logout": { req: typeof LogoutBody; res: { ok: true } };
  /** The latest 20 attempts, newest first. */
  "GET /api/logins": { res: LoginRecord[] };
  /** The phone takes the list from the WS; this route serves the curl checks of spec 12. */
  "GET /api/sessions": { res: Session[] };
  /** Oldest first, strictly older than `before`. Fewer than `limit` means the start of the transcript. */
  "GET /api/sessions/:id/chat": { query: typeof ChatQuery; res: ChatEvent[] };
  "GET /api/sessions/:id/blocked": { res: BlockedDialog };
}
export type ApiRoute = keyof ApiContract;
export type ApiRes<R extends ApiRoute> = ApiContract[R]["res"];
