import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import { makeSessionId, parseClaudeSessionId } from "#shared/domain";
import type { ClaudeSessionId, Session } from "#shared/domain";

const dir = mkdtempSync(join(tmpdir(), "sc-http-"));
process.env.SESSION_CONSOLE_DIR = join(dir, "state");
const { createAuth, hashPassphrase } = await import("#auth");
const { openConfig } = await import("#config");
const { createHttpServer } = await import("#http");

const PASS = "correct horse battery";
const OWNER = "owner@example.com";
const ORIGIN = "https://console.example.ts.net";
const config = openConfig();
await config.write({ version: 1, ownerLogin: OWNER, publicOrigin: ORIGIN, port: 7421, herdrBin: "herdr", passphrase: await hashPassphrase(PASS) });

const staticDir = join(dir, "dist");
mkdirSync(join(staticDir, "assets"), { recursive: true });
writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>shell</title>");
writeFileSync(join(staticDir, "assets", "app.js"), "console.log(1)");
writeFileSync(join(dir, "secret.txt"), "outside the bundle");

const CID = parseClaudeSessionId("00000000-0000-4000-8000-000000000001")!;
const ID = makeSessionId("herdr", "default", "w11:p1");
const session = {
  id: ID, source: "herdr", group: "default", paneId: "w11:p1", terminalId: "term_1", workspaceLabel: "label", title: null, cwd: null,
  agent: "claude", claudeSessionId: CID, stateChangeSeq: 1, reachable: true, status: "blocked", transcriptPath: "/p/x.jsonl",
} as Session;
const pages: [ClaudeSessionId, string | null, number][] = [];
const attached: string[] = [];
const flags = { devNoTailscale: false, devOrigin: "http://localhost:5173" };
const server = createHttpServer({
  auth: createAuth({ config, flags }),
  registry: {
    setActive() {},
    current: () => ({ groups: [], sessions: [session] }),
    get: (id) => (id === ID ? session : undefined),
    list: async () => ({ groups: [], sessions: [session] }),
    subscribe: () => () => {},
  },
  transcripts: {
    locate: async () => null,
    page: async (cid, before, limit) => {
      pages.push([cid, before, limit]);
      return { ok: true, events: [] };
    },
    follow() {},
    onAppend: () => () => {},
  },
  sources: { herdr: { kind: "herdr", poll: async () => ({ groups: [], sessions: [] }), send: async () => ({ ok: true }), readDialog: async () => ({ ok: true, text: "❯ 1. Yes\n  2. No" }), observeTerminal: () => ({ resync() {}, close() {} }), close: async () => {} } },
  hub: {
    attach(ws) {
      attached.push("attached");
      ws.close(1000);
    },
    close() {},
  },
  staticDir,
  config,
  flags,
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
  server.closeAllConnections();
  server.close();
});

const tailnet = { "Tailscale-User-Login": OWNER };
const call = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { ...tailnet, ...init.headers } });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { Origin: ORIGIN, "Content-Type": "application/json", "X-Forwarded-For": "192.0.2.50", ...headers } });
let cookie = "";
async function member(): Promise<string> {
  if (!cookie) {
    const r = await post("/api/login", { passphrase: PASS }, { "X-Forwarded-For": "192.0.2.99" });
    cookie = (r.headers.get("set-cookie") ?? "").split(";")[0]!;
  }
  return cookie;
}

test("without the Tailscale header every path is 403, as the denial page for browsers", async () => {
  const page = await fetch(`${base}/`, { headers: { Accept: "text/html" } });
  assert.equal(page.status, 403);
  assert.match(await page.text(), /이 기기는 허용되지 않았습니다\./);
  const apiReply = await fetch(`${base}/api/sessions`);
  assert.equal(apiReply.status, 403);
  assert.deepEqual(await apiReply.json(), { error: "forbidden" });
  assert.equal((await fetch(`${base}/assets/app.js`, { headers: { "Tailscale-User-Login": "intruder@example.com" } })).status, 403);
});

test("member routes need the login cookie; /api/me answers either way", async () => {
  const r = await call("/api/sessions");
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { error: "unauthorized" });
  assert.deepEqual(await (await call("/api/me")).json(), { loggedIn: false, tailscaleLogin: OWNER, deviceName: null });
  assert.deepEqual(await (await call("/api/me", { headers: { Cookie: await member() } })).json(), { loggedIn: true, tailscaleLogin: OWNER, deviceName: null });
});

test("login: 401 with remaining, 429 with retry_after after five failures, 200 with the cookie", async () => {
  const wrong = () => post("/api/login", { passphrase: "nope" }, { "X-Forwarded-For": "192.0.2.60" });
  const first = await wrong();
  assert.equal(first.status, 401);
  assert.deepEqual(await first.json(), { error: "wrong_passphrase", remaining: 4 });
  for (let i = 0; i < 4; i++) await wrong();
  const limited = await wrong();
  assert.equal(limited.status, 429);
  const body = (await limited.json()) as { error: string; retry_after: number };
  assert.equal(body.error, "rate_limited");
  assert.ok(body.retry_after > 50 && body.retry_after <= 60, `retry_after ${body.retry_after}`);
  const ok = await post("/api/login", { passphrase: PASS }, { "X-Forwarded-For": "192.0.2.61" });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("set-cookie") ?? "", /^sc=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000; Secure$/);
  assert.equal(ok.headers.get("cache-control"), "no-store");
});

test("a POST from another Origin is 403 before anything else runs", async () => {
  for (const origin of ["https://evil.example", ""]) {
    const r = await post("/api/login", { passphrase: PASS }, { Origin: origin });
    assert.equal(r.status, 403, origin);
    assert.deepEqual(await r.json(), { error: "forbidden" });
  }
  assert.equal((await post("/api/login", { passphrase: "nope" }, { Origin: "http://localhost:5173", "X-Forwarded-For": "192.0.2.70" })).status, 401, "the dev origin is allowed");
});

test("a body that is not valid JSON, or not the route's schema, is invalid_command", async () => {
  for (const body of ["{", JSON.stringify({ pass: "x" }), JSON.stringify({ passphrase: "" })]) {
    const r = await post("/api/login", body);
    assert.equal(r.status, 400, body);
    assert.deepEqual(await r.json(), { error: "invalid_command" });
  }
});

test("the :id segment is percent-decoded before it is parsed, and a bad escape is invalid_command", async () => {
  const headers = { Cookie: await member() };
  const chat = await call(`/api/sessions/${encodeURIComponent(ID)}/chat?before=u-9&limit=20`, { headers });
  assert.equal(chat.status, 200);
  assert.deepEqual(pages.at(-1), [CID, "u-9", 20]);
  await call(`/api/sessions/${encodeURIComponent(ID)}/chat`, { headers });
  assert.deepEqual(pages.at(-1), [CID, null, 50], "defaults from ChatQuery");
  const blocked = await call(`/api/sessions/${encodeURIComponent(ID)}/blocked`, { headers });
  assert.deepEqual(((await blocked.json()) as { options: unknown }).options, [{ key: "1", label: "Yes" }, { key: "2", label: "No" }]);
  const cases: [path: string, status: number, error: string][] = [
    ["/api/sessions/%E0%A4%A/chat", 400, "invalid_command"],
    [`/api/sessions/${encodeURIComponent("herdr:default/w404:p1")}/chat`, 410, "pane_closed"],
    ["/api/sessions/not-an-id/chat", 400, "invalid_command"],
    [`/api/sessions/${encodeURIComponent(ID)}/chat?limit=999`, 400, "invalid_command"],
    ["/api/nothing-here", 400, "invalid_command"],
  ];
  for (const [path, status, error] of cases) {
    const r = await call(path, { headers });
    assert.equal(r.status, status, path);
    assert.deepEqual(await r.json(), { error }, path);
  }
});

test("static files are served, unknown paths get the SPA shell, and nothing outside the bundle leaks", async () => {
  const js = await call("/assets/app.js");
  assert.equal(js.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(await js.text(), "console.log(1)");
  for (const path of ["/", "/s/herdr/default/w11:p1", "/login", "/../secret.txt", "/%2e%2e/secret.txt"]) {
    const r = await call(path);
    assert.equal(r.status, 200, path);
    assert.equal(await r.text(), "<!doctype html><title>shell</title>", path);
  }
});

test("every response carries the CSP with the wss host of the public origin and the dev host", async () => {
  const r = await call("/");
  assert.equal(
    r.headers.get("content-security-policy"),
    "default-src 'self'; connect-src 'self' wss://console.example.ts.net ws://localhost:5173; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  );
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
});

test("the WS upgrade needs gate 1, the Origin and the cookie", async () => {
  const open = (headers: Record<string, string>) =>
    new Promise<string>((resolve) => {
      const ws = new WebSocket(`${base.replace("http", "ws")}/ws`, { headers });
      ws.on("unexpected-response", (request, res) => {
        request.destroy();
        resolve(String(res.statusCode));
      });
      ws.on("open", () => resolve("open"));
      ws.on("error", () => resolve("error"));
    });
  const c = await member();
  assert.equal(await open({ Origin: ORIGIN }), "403", "no Tailscale header");
  assert.equal(await open({ ...tailnet, Origin: "https://evil.example", Cookie: c }), "403", "wrong origin");
  assert.equal(await open({ ...tailnet, Origin: ORIGIN }), "401", "no cookie");
  assert.equal(await open({ ...tailnet, Origin: ORIGIN, Cookie: c }), "open");
  assert.deepEqual(attached, ["attached"]);
});
