import type { IncomingMessage } from "node:http";
import { z } from "zod";
import type { Brand } from "#shared/domain";
import type { LoginRecord, LoginReply } from "#shared/protocol";
import type { ConsoleConfig, FileCell, RuntimeFlags, ScryptHash } from "#config";

/** sha256 hex of the cookie token. The raw token exists only in the phone's cookie. */
export type TokenHash = Brand<string, "TokenHash">;

/** Spec 6.5. The server is the only writer of PATHS.tokens; it drops dead entries whenever it writes. */
const AuthSessionSchema = z.object({
  tokenHash: z.custom<TokenHash>((v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v)),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  userAgent: z.string(),
});
export type AuthSession = z.infer<typeof AuthSessionSchema>;

/** The result of both gates for one HTTP request or WS upgrade. Routes branch on this and nothing else. */
export type Access =
  | { kind: "forbidden" } // gate 1 failed: 403 everywhere, static files included
  | { kind: "anonymous"; login: string } // gate 1 passed, no live cookie: 401 on member routes
  | { kind: "member"; login: string; token: TokenHash };

export interface Auth {
  /** Gate 1 (Tailscale-User-Login === ownerLogin), then gate 2 (a cookie whose session isLive). Sync: cells cost a stat each. */
  check(req: IncomingMessage): Access;
  /** Origin equals config.publicOrigin or flags.devOrigin. */
  originAllowed(req: IncomingMessage): boolean;
  /**
   * Rate limit first (5 failures per minute per client IP, plus 20 per minute overall because a local process can
   * forge X-Forwarded-For), then scrypt and a constant-time compare, then a new 32-byte token. Every attempt is
   * appended to PATHS.logins with time, Tailscale login and device; the passphrase never is.
   */
  login(req: IncomingMessage, passphrase: string): Promise<{ status: 200 | 401 | 429; body: LoginReply; setCookie?: string }>;
  /** "this" rewrites tokens.json without the token; "all" writes revoked-by-server = now. Returns a clearing Set-Cookie. */
  logout(token: TokenHash, scope: "this" | "all"): Promise<string>;
  loginLog(limit: number): Promise<LoginRecord[]>;
  /** Device name from `tailscale whois <ip> --json`, cached per IP. null in dev or on any failure. */
  deviceName(req: IncomingMessage): Promise<string | null>;
  /** The hub asks on every command and every heartbeat, so a revoked phone loses its socket within one heartbeat. */
  isTokenLive(token: TokenHash): boolean;
}

export function createAuth(deps: { config: FileCell<ConsoleConfig | null>; flags: RuntimeFlags }): Auth {
  // TODO state: tokens = fileCell(PATHS.tokens, z.array(AuthSessionSchema), []);
  //   markers = [PATHS.revokedByCli, PATHS.revokedByServer].map(p => fileCell(p, z.iso.datetime().nullable(), null))
  //   revokedBefore() = the later of the two markers, or null
  //   live(hash) = tokens.read().find(s => s.tokenHash === hash && isLive(s, revokedBefore(), new Date()))
  //   failures: Map<clientKey, number[]> and one global number[]; 60-second sliding windows. Correct passphrase clears the key.
  //   whois: Map<ip, string | null>
  // clientKey(req) = first X-Forwarded-For hop (Tailscale Serve sets it; inferred, verify) else req.socket.remoteAddress
  // gate 1: flags.devNoTailscale || req.headers["tailscale-user-login"] === config.read()!.ownerLogin
  // cookie: `sc=<base64url 32 bytes>; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` plus `; Secure` unless devNoTailscale
  // login reads config.read()!.passphrase per attempt, so a passphrase changed by the CLI applies without a restart.
  throw new Error("not implemented");
}

/** The one liveness rule. The server, `pnpm revoke-all` and tests call it, so they cannot disagree. */
export function isLive(s: AuthSession, revokedBefore: string | null, now: Date): boolean {
  return Date.parse(s.expiresAt) > now.getTime() && (revokedBefore === null || Date.parse(s.createdAt) > Date.parse(revokedBefore));
}

/** Pass maxmem: 64 MiB. With Node's default 32 MiB, N=2^15 r=8 throws ERR_CRYPTO_INVALID_SCRYPT_PARAMS (measured). */
export async function hashPassphrase(passphrase: string): Promise<ScryptHash> {
  throw new Error("not implemented");
}

/**
 * For CLI processes only. Lists the sessions isLive still accepts, then writes revoked-by-cli = now. It never writes
 * tokens.json, which belongs to the server; a running server rejects those tokens on its next check.
 */
export async function revokeAll(now: Date = new Date()): Promise<AuthSession[]> {
  throw new Error("not implemented");
}
