import { execFile } from "node:child_process";
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { ScryptOptions } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, open } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { promisify } from "node:util";
import { z } from "zod";
import type { Brand } from "#shared/domain";
import type { LoginRecord, LoginReply } from "#shared/protocol";
import { fileCell, PATHS } from "#config";
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
   * forge X-Forwarded-For), then scrypt and a constant-time compare, then a new 32-byte token. An attempt holds its
   * slot while scrypt runs, so parallel attempts cannot pass the limit together. Every attempt that reaches the
   * passphrase check is appended to PATHS.logins with time, Tailscale login and device; the passphrase never is.
   * Rate-limited attempts are not logged, so the log grows by at most 20 lines a minute.
   */
  login(req: IncomingMessage, passphrase: string): Promise<{ status: 200 | 401 | 429; body: LoginReply; setCookie?: string }>;
  /** "this" rewrites tokens.json without the token; "all" writes revoked-by-server = now. Returns a clearing Set-Cookie. */
  logout(token: TokenHash, scope: "this" | "all"): Promise<string>;
  loginLog(limit: number): Promise<LoginRecord[]>;
  /**
   * Device name from `tailscale whois --json <ip>` (Node.ComputedName, e.g. "iphone181"), cached per IP. Asked only
   * for a tailnet address in X-Forwarded-For. null in dev or on any failure.
   */
  deviceName(req: IncomingMessage): Promise<string | null>;
  /** The hub asks on every command and every heartbeat, so a revoked phone loses its socket within one heartbeat. */
  isTokenLive(token: TokenHash): boolean;
}

const COOKIE = "sc";
const TOKEN_DAYS = 30;
const WINDOW_MS = 60_000;
const PER_CLIENT = 5;
const OVERALL = 20;
const MarkerSchema = z.iso.datetime().nullable();
const LoginRecordSchema = z.object({ ts: z.string(), ok: z.boolean(), tailscaleLogin: z.string(), device: z.string() });

const tokensCell = () => fileCell(PATHS.tokens, z.array(AuthSessionSchema), []);
const markerCells = () => ({ cli: fileCell(PATHS.revokedByCli, MarkerSchema, null), server: fileCell(PATHS.revokedByServer, MarkerSchema, null) });
const latest = (...marks: (string | null)[]): string | null =>
  marks.reduce<string | null>((a, b) => (b !== null && (a === null || Date.parse(b) > Date.parse(a)) ? b : a), null);

export function createAuth(deps: { config: FileCell<ConsoleConfig | null>; flags: RuntimeFlags }): Auth {
  const tokens = tokensCell();
  const markers = markerCells();
  const failures = new Map<string, number[]>();
  const overall: number[] = [];
  const whois = new Map<string, Promise<string | null>>();
  let writes: Promise<unknown> = Promise.resolve();

  const revokedBefore = () => latest(markers.cli.read(), markers.server.read());
  const isLiveHash = (hash: TokenHash) => tokens.read().some((s) => s.tokenHash === hash && isLive(s, revokedBefore(), new Date()));
  const cookie = (value: string, maxAge: number) =>
    `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${deps.flags.devNoTailscale ? "" : "; Secure"}`;

  /** The one writer of tokens.json; serialized, and every write drops dead entries. */
  function rewriteTokens(edit: (live: AuthSession[]) => AuthSession[]): Promise<void> {
    const run = writes.then(async () => {
      const now = new Date();
      const before = revokedBefore();
      await tokens.write(edit(tokens.read().filter((s) => isLive(s, before, now))));
    });
    writes = run.catch(() => {});
    return run;
  }

  async function lookupDevice(ip: string): Promise<string | null> {
    try {
      const { stdout } = await promisify(execFile)(tailscaleBin(), ["whois", "--json", ip], { timeout: 3000 });
      const node = (JSON.parse(stdout) as { Node?: { ComputedName?: unknown; Name?: unknown } }).Node;
      const name = typeof node?.ComputedName === "string" && node.ComputedName ? node.ComputedName : typeof node?.Name === "string" ? node.Name.split(".")[0] : "";
      return name || null;
    } catch {
      return null;
    }
  }

  async function deviceName(req: IncomingMessage): Promise<string | null> {
    const ip = forwardedFor(req);
    if (deps.flags.devNoTailscale || !ip || !isTailnetAddress(ip)) return null;
    let found = whois.get(ip);
    if (!found) {
      found = lookupDevice(ip);
      whois.set(ip, found);
      void found.then((name) => name === null && whois.delete(ip));
    }
    return found;
  }

  return {
    check(req) {
      const config = deps.config.read();
      if (!config) return { kind: "forbidden" };
      if (!deps.flags.devNoTailscale && header(req, "tailscale-user-login") !== config.ownerLogin) return { kind: "forbidden" };
      const login = config.ownerLogin;
      const token = cookieToken(req);
      if (!token) return { kind: "anonymous", login };
      const hash = sha256(token) as TokenHash;
      return isLiveHash(hash) ? { kind: "member", login, token: hash } : { kind: "anonymous", login };
    },

    originAllowed(req) {
      const config = deps.config.read();
      const origin = header(req, "origin");
      if (!config || !origin) return false;
      return [config.publicOrigin, deps.flags.devOrigin].some((allowed) => allowed !== null && sameOrigin(allowed, origin));
    },

    async login(req, passphrase) {
      const config = deps.config.read();
      if (!config) throw new Error("config.json is missing; run `pnpm passphrase`");
      const now = Date.now();
      const key = clientKey(req);
      prune(overall, now);
      for (const [k, window] of failures) {
        prune(window, now);
        if (!window.length) failures.delete(k);
      }
      const mine = failures.get(key) ?? [];
      if (mine.length >= PER_CLIENT || overall.length >= OVERALL) {
        const until = Math.max(mine.length >= PER_CLIENT ? mine[mine.length - PER_CLIENT]! : 0, overall.length >= OVERALL ? overall[overall.length - OVERALL]! : 0);
        return { status: 429, body: { error: "rate_limited", retry_after: Math.max(1, Math.ceil((until + WINDOW_MS - now) / 1000)) } };
      }
      mine.push(now);
      failures.set(key, mine);
      overall.push(now);

      const ok = await verifyPassphrase(passphrase, config.passphrase);
      const userAgent = (header(req, "user-agent") ?? "").slice(0, 200);
      await appendLogin({ ts: new Date(now).toISOString(), ok, tailscaleLogin: config.ownerLogin, device: (await deviceName(req)) ?? deviceKind(userAgent) });
      if (!ok) return { status: 401, body: { error: "wrong_passphrase", remaining: Math.max(0, Math.min(PER_CLIENT - mine.length, OVERALL - overall.length)) } };

      failures.delete(key);
      overall.splice(overall.indexOf(now), 1);
      const token = randomBytes(32).toString("base64url");
      const createdAt = new Date(now);
      const expiresAt = new Date(now + TOKEN_DAYS * 86_400_000);
      await rewriteTokens((live) => [
        ...live,
        { tokenHash: sha256(token) as TokenHash, createdAt: createdAt.toISOString(), expiresAt: expiresAt.toISOString(), userAgent },
      ]);
      return { status: 200, body: { ok: true }, setCookie: cookie(token, TOKEN_DAYS * 86_400) };
    },

    async logout(token, scope) {
      if (scope === "all") {
        const run = writes.then(() => markers.server.write(new Date().toISOString()));
        writes = run.catch(() => {});
        await run;
        await rewriteTokens((live) => live);
      } else {
        await rewriteTokens((live) => live.filter((s) => s.tokenHash !== token));
      }
      return cookie("", 0);
    },

    async loginLog(limit) {
      const tail = await readTail(PATHS.logins, 64 * 1024);
      return tail
        .flatMap((line) => {
          try {
            const r = LoginRecordSchema.safeParse(JSON.parse(line));
            return r.success ? [r.data] : [];
          } catch {
            return [];
          }
        })
        .slice(-limit)
        .reverse();
    },

    deviceName,
    isTokenLive: isLiveHash,
  };
}

/** The one liveness rule. The server, `pnpm revoke-all` and tests call it, so they cannot disagree. */
export function isLive(s: AuthSession, revokedBefore: string | null, now: Date): boolean {
  return Date.parse(s.expiresAt) > now.getTime() && (revokedBefore === null || Date.parse(s.createdAt) > Date.parse(revokedBefore));
}

/** Pass maxmem: 64 MiB. With Node's default 32 MiB, N=2^15 r=8 throws ERR_CRYPTO_INVALID_SCRYPT_PARAMS (measured). */
export async function hashPassphrase(passphrase: string): Promise<ScryptHash> {
  const salt = randomBytes(16);
  const params = { N: 32768, r: 8, p: 1, keyLen: 64 } as const;
  const hash = await derive(passphrase, salt, params.keyLen, { N: params.N, r: params.r, p: params.p });
  return { algo: "scrypt", ...params, salt: salt.toString("base64"), hash: hash.toString("base64") };
}

/**
 * For CLI processes only. Lists the sessions isLive still accepts, then writes revoked-by-cli = now. It never writes
 * tokens.json, which belongs to the server; a running server rejects those tokens on its next check.
 */
export async function revokeAll(now: Date = new Date()): Promise<AuthSession[]> {
  const markers = markerCells();
  const before = latest(markers.cli.read(), markers.server.read());
  const alive = tokensCell()
    .read()
    .filter((s) => isLive(s, before, now));
  await markers.cli.write(now.toISOString());
  return alive;
}

async function verifyPassphrase(passphrase: string, stored: ScryptHash): Promise<boolean> {
  const expected = Buffer.from(stored.hash, "base64");
  const actual = await derive(passphrase, Buffer.from(stored.salt, "base64"), stored.keyLen, { N: stored.N, r: stored.r, p: stored.p });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function derive(passphrase: string, salt: Buffer, keyLen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(passphrase.normalize("NFC"), salt, keyLen, { ...options, maxmem: 64 * 1024 * 1024 }, (e, key) => (e ? reject(e) : resolve(key))),
  );
}

async function appendLogin(record: LoginRecord): Promise<void> {
  await mkdir(PATHS.dir, { recursive: true, mode: 0o700 });
  await appendFile(PATHS.logins, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/** Whole lines from the last `bytes` of a file; [] when it does not exist. */
async function readTail(path: string, bytes: number): Promise<string[]> {
  const fh = await open(path, "r").catch(() => null);
  if (!fh) return [];
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    return (start > 0 ? lines.slice(1) : lines).filter(Boolean);
  } finally {
    await fh.close();
  }
}

/** Drops, in place, the timestamps that left the sliding window. */
function prune(window: number[], now: number): void {
  while (window.length && window[0]! <= now - WINDOW_MS) window.shift();
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function cookieToken(req: IncomingMessage): string | null {
  for (const part of (header(req, "cookie") ?? "").split(";")) {
    const [k, v] = part.trim().split("=", 2);
    if (k === COOKIE && v && /^[A-Za-z0-9_-]{43}$/.test(v)) return v;
  }
  return null;
}

/** The first X-Forwarded-For hop, which Tailscale Serve sets to the phone's tailnet address (inferred; spec open question). */
function forwardedFor(req: IncomingMessage): string | null {
  return header(req, "x-forwarded-for")?.split(",")[0]?.trim() || null;
}

function clientKey(req: IncomingMessage): string {
  return forwardedFor(req) ?? req.socket?.remoteAddress ?? "unknown";
}

function isTailnetAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 100 && b! >= 64 && b! < 128;
  }
  return isIP(ip) === 6 && ip.toLowerCase().startsWith("fd7a:115c:a1e0:");
}

function sameOrigin(allowed: string, origin: string): boolean {
  try {
    return new URL(allowed).origin === origin;
  } catch {
    return false;
  }
}

const DEVICE_KINDS: readonly [RegExp, string][] = [
  [/iPhone/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android/, "Android"],
  [/Macintosh/, "Mac"],
  [/Windows/, "Windows"],
  [/Linux/, "Linux"],
];
const deviceKind = (userAgent: string): string => DEVICE_KINDS.find(([re]) => re.test(userAgent))?.[1] ?? "unknown";

let tailscalePath: string | null = null;
function tailscaleBin(): string {
  tailscalePath ??= existsSync("/Applications/Tailscale.app/Contents/MacOS/Tailscale") ? "/Applications/Tailscale.app/Contents/MacOS/Tailscale" : "tailscale";
  return tailscalePath;
}
