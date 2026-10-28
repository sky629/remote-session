import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "sc-auth-"));
process.env.SESSION_CONSOLE_DIR = dir;
const { createAuth, hashPassphrase, isLive, revokeAll } = await import("#auth");
const { openConfig, PATHS } = await import("#config");
type AuthSession = import("#auth").AuthSession;

const PASS = "correct horse battery";
const OWNER = "owner@example.com";
const ORIGIN = "https://console.example.ts.net";
const config = openConfig();
await config.write({ version: 1, ownerLogin: OWNER, publicOrigin: ORIGIN, port: 7421, herdrBin: "herdr", passphrase: await hashPassphrase(PASS) });

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)";
const req = (headers: Record<string, string | undefined> = {}, ip = "192.0.2.10") =>
  ({ headers: { "tailscale-user-login": OWNER, "x-forwarded-for": ip, "user-agent": IPHONE_UA, ...headers }, socket: { remoteAddress: "127.0.0.1" } }) as unknown as IncomingMessage;
const auth = (flags: { devNoTailscale?: boolean; devOrigin?: string | null } = {}) =>
  createAuth({ config, flags: { devNoTailscale: flags.devNoTailscale ?? false, devOrigin: flags.devOrigin ?? null } });
const tokenOf = (setCookie: string | undefined) => /^sc=([^;]+)/.exec(setCookie ?? "")?.[1] ?? "";
const withCookie = (token: string) => req({ cookie: `sc=${token}` });
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
function hashOf(a: ReturnType<typeof auth>, token: string) {
  const access = a.check(withCookie(token));
  assert.equal(access.kind, "member");
  return (access as Extract<typeof access, { kind: "member" }>).token;
}

async function loginToken(a: ReturnType<typeof auth>, ip = "192.0.2.200"): Promise<string> {
  const r = await a.login(req({}, ip), PASS);
  assert.equal(r.status, 200);
  return tokenOf(r.setCookie);
}

test("hashPassphrase stores scrypt parameters, a 16-byte salt and a 64-byte hash, salted per call", async () => {
  const a = await hashPassphrase("same");
  const b = await hashPassphrase("same");
  assert.deepEqual({ algo: a.algo, N: a.N, r: a.r, p: a.p, keyLen: a.keyLen }, { algo: "scrypt", N: 32768, r: 8, p: 1, keyLen: 64 });
  assert.equal(Buffer.from(a.salt, "base64").length, 16);
  assert.equal(Buffer.from(a.hash, "base64").length, 64);
  assert.notEqual(a.hash, b.hash);
});

test("the right passphrase logs in with a 30-day HttpOnly Strict cookie; the wrong one is refused", async () => {
  const a = auth();
  const ok = await a.login(req({}, "192.0.2.1"), PASS);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { ok: true });
  assert.match(ok.setCookie ?? "", /^sc=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000; Secure$/);
  assert.equal(a.check(withCookie(tokenOf(ok.setCookie))).kind, "member");
  assert.deepEqual(await a.login(req({}, "192.0.2.1"), "wrong"), { status: 401, body: { error: "wrong_passphrase", remaining: 4 } });
  const dev = await auth({ devNoTailscale: true }).login(req({}, "192.0.2.2"), PASS);
  assert.doesNotMatch(dev.setCookie ?? "", /Secure/, "plain-HTTP dev drops Secure");
});

test("five failures per client per minute, then 429 until the window slides", async () => {
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-28T00:00:00Z") });
  try {
    const a = auth();
    const r = () => a.login(req({}, "192.0.2.3"), "wrong");
    const remaining = [];
    for (let i = 0; i < 5; i++) remaining.push(((await r()).body as { remaining: number }).remaining);
    assert.deepEqual(remaining, [4, 3, 2, 1, 0]);
    assert.deepEqual(await r(), { status: 429, body: { error: "rate_limited", retry_after: 60 } });
    assert.equal((await a.login(req({}, "192.0.2.4"), "wrong")).status, 401, "another client is still heard");
    mock.timers.tick(30_000);
    assert.deepEqual(await r(), { status: 429, body: { error: "rate_limited", retry_after: 30 } });
    mock.timers.tick(30_000);
    assert.equal((await r()).status, 401, "the window slid");
  } finally {
    mock.timers.reset();
  }
});

test("a correct passphrase clears that client's failures", async () => {
  const a = auth();
  for (let i = 0; i < 3; i++) await a.login(req({}, "192.0.2.5"), "wrong");
  await loginToken(a, "192.0.2.5");
  assert.deepEqual((await a.login(req({}, "192.0.2.5"), "wrong")).body, { error: "wrong_passphrase", remaining: 4 });
});

test("twenty failures a minute overall stop every client, so forged X-Forwarded-For values do not help", async () => {
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-28T01:00:00Z") });
  try {
    const a = auth();
    for (let ip = 0; ip < 4; ip++) for (let i = 0; i < 5; i++) assert.equal((await a.login(req({}, `198.51.100.${ip}`), "wrong")).status, 401);
    assert.deepEqual(await a.login(req({}, "198.51.100.99"), PASS), { status: 429, body: { error: "rate_limited", retry_after: 60 } });
  } finally {
    mock.timers.reset();
  }
});

test("parallel attempts hold their slots while scrypt runs, so only five get through", async () => {
  const a = auth();
  const statuses = (await Promise.all(Array.from({ length: 8 }, () => a.login(req({}, "192.0.2.6"), "wrong")))).map((r) => r.status);
  assert.deepEqual(statuses.sort(), [401, 401, 401, 401, 401, 429, 429, 429]);
});

test("gate 1 then the cookie gate decide the access kind", async () => {
  const a = auth();
  const token = await loginToken(a);
  const cases: [name: string, r: IncomingMessage, kind: string, dev?: boolean][] = [
    ["no Tailscale header", req({ "tailscale-user-login": undefined }), "forbidden"],
    ["another Tailscale login", req({ "tailscale-user-login": "intruder@example.com" }), "forbidden"],
    ["the owner without a cookie", req(), "anonymous"],
    ["the owner with a live cookie", withCookie(token), "member"],
    ["the cookie among others", req({ cookie: `theme=dark; sc=${token}; x=1` }), "member"],
    ["a malformed cookie", req({ cookie: "sc=../../etc" }), "anonymous"],
    ["an unknown token", withCookie("A".repeat(43)), "anonymous"],
    ["dev mode without the header", req({ "tailscale-user-login": undefined }), "anonymous", true],
  ];
  for (const [name, r, kind, dev] of cases) assert.equal(auth({ devNoTailscale: dev }).check(r).kind, kind, name);
  assert.deepEqual(a.check(withCookie(token)), { kind: "member", login: OWNER, token: sha256(token) }, "the server keys a login by the sha256 of its token");
});

test("Origin must be the public origin, or the dev origin when one is set", () => {
  const cases: [origin: string | undefined, devOrigin: string | null, allowed: boolean][] = [
    [ORIGIN, null, true],
    ["https://evil.example", null, false],
    [undefined, null, false],
    ["http://localhost:5173", null, false],
    ["http://localhost:5173", "http://localhost:5173", true],
    [`${ORIGIN}:8443`, null, false],
  ];
  for (const [origin, devOrigin, allowed] of cases) assert.equal(auth({ devOrigin }).originAllowed(req({ origin })), allowed, `${origin} with dev ${devOrigin}`);
});

test("isLive: unexpired and created after the latest revocation", () => {
  const s: AuthSession = { tokenHash: "0".repeat(64) as AuthSession["tokenHash"], createdAt: "2026-10-01T00:00:00.000Z", expiresAt: "2026-10-31T00:00:00.000Z", userAgent: "" };
  const now = new Date("2026-10-28T00:00:00Z");
  const cases: [name: string, revokedBefore: string | null, at: Date, live: boolean][] = [
    ["no revocation", null, now, true],
    ["revoked before it was created", "2026-09-30T00:00:00.000Z", now, true],
    ["revoked after it was created", "2026-10-02T00:00:00.000Z", now, false],
    ["revoked at the same instant", s.createdAt, now, false],
    ["expired", null, new Date("2026-10-31T00:00:00Z"), false],
  ];
  for (const [name, revokedBefore, at, live] of cases) assert.equal(isLive(s, revokedBefore, at), live, name);
});

test("logout this, logout all, revoke-all and expiry each end a login, and tokens.json holds hashes only", async () => {
  const a = auth();
  const one = await loginToken(a);
  const two = await loginToken(a);
  await a.logout(hashOf(a, one), "this");
  assert.equal(a.check(withCookie(one)).kind, "anonymous", "this device is out");
  assert.equal(a.check(withCookie(two)).kind, "member", "the other device stays");
  assert.doesNotMatch(readFileSync(PATHS.tokens, "utf8"), new RegExp(two));

  const cleared = await a.logout(hashOf(a, two), "all");
  assert.match(cleared, /^sc=; HttpOnly; SameSite=Strict; Path=\/; Max-Age=0/);
  assert.equal(a.check(withCookie(two)).kind, "anonymous", "every device is out");
  assert.deepEqual(JSON.parse(readFileSync(PATHS.tokens, "utf8")), [], "dead entries are dropped on write");

  await new Promise((r) => setTimeout(r, 5));
  const three = await loginToken(a);
  const threeHash = hashOf(a, three);
  const revoked = await revokeAll();
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0]!.userAgent, IPHONE_UA);
  assert.equal(a.isTokenLive(threeHash), false);
  assert.equal(a.check(withCookie(three)).kind, "anonymous", "the server sees the CLI marker without a restart");

  await new Promise((r) => setTimeout(r, 5));
  const four = await loginToken(a);
  assert.equal(a.check(withCookie(four)).kind, "member", "a login after the marker is live");
  mock.timers.enable({ apis: ["Date"], now: Date.now() + 30 * 86_400_000 + 1000 });
  try {
    assert.equal(a.check(withCookie(four)).kind, "anonymous", "expired after 30 days");
  } finally {
    mock.timers.reset();
  }
});

test("every checked attempt is logged with its outcome and device, newest first, never the passphrase", async () => {
  const log = await auth().loginLog(20);
  assert.ok(log.length >= 2 && log.length <= 20);
  assert.ok(log.every((r) => r.tailscaleLogin === OWNER && r.device === "iPhone"));
  assert.ok(log.some((r) => r.ok) && log.some((r) => !r.ok));
  const stamps = log.map((r) => Date.parse(r.ts));
  assert.deepEqual(stamps, [...stamps].sort((x, y) => y - x));
  const raw = readFileSync(PATHS.logins, "utf8");
  assert.ok(!raw.includes(PASS) && !raw.includes("wrong\""), "no passphrase in the log");
});
