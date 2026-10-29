// Read-only smoke test against the real herdr and Claude transcripts on this Mac. It never sends input to a pane.
// A temp SESSION_CONSOLE_DIR holds the config, so ~/.config/session-console is never touched.
// Prints labels, statuses, counts and frame sizes only: no titles, no message bodies, no passphrase.
// Usage: node scripts/smoke-readonly.mjs        Exits non-zero on any mismatch.
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";

const PORT = 7421;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = BASE;
const PASS = `smoke-${Math.random().toString(36).slice(2)}-passphrase`;
const repo = new URL("..", import.meta.url).pathname;
const state = mkdtempSync(join(tmpdir(), "sc-smoke-"));
process.env.SESSION_CONSOLE_DIR = state;

const { hashPassphrase } = await import("#auth");
const { openConfig } = await import("#config");
const { WebSocket } = await import("ws");
const run = promisify(execFile);

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures++;
};
const herdrJson = async (args) => JSON.parse((await run("herdr", args, { timeout: 10_000 })).stdout);
const layoutOf = async (group, paneId) => (await herdrJson(["--session", group, "pane", "layout", "--pane", paneId])).result.layout;
const focusOf = async (group) => (await herdrJson(["--session", group, "agent", "list"])).result.agents.map((a) => [a.pane_id, a.focused]);
const observers = async (terminalId) =>
  (await run("ps", ["-axo", "pid=,command="])).stdout.split("\n").filter((l) => l.includes("terminal session observe") && l.includes(terminalId));

await openConfig().write({
  version: 1,
  ownerLogin: "smoke@example.invalid",
  publicOrigin: ORIGIN,
  port: PORT,
  herdrBin: "herdr",
  passphrase: await hashPassphrase(PASS),
});

const server = spawn(process.execPath, ["server/src/main.ts"], {
  cwd: repo,
  env: { ...process.env, CONSOLE_DEV_NO_TAILSCALE: "1", SESSION_CONSOLE_DIR: state },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
const serverExit = new Promise((r) => server.on("exit", (code, signal) => r(code ?? signal)));

async function main() {
  for (let i = 0; i < 100 && !serverLog.includes("실행 중입니다"); i++) await new Promise((r) => setTimeout(r, 100));
  check(serverLog.includes("실행 중입니다"), `server started on ${BASE} with state in a temp dir`);

  const login = await fetch(`${BASE}/api/login`, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ passphrase: PASS }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  check(login.status === 200 && /^sc=/.test(cookie), `login 200 with a cookie (got ${login.status})`);
  const get = (path) => fetch(`${BASE}${path}`, { headers: { Cookie: cookie } });

  const me = await (await get("/api/me")).json();
  check(me.loggedIn === true, `/api/me says loggedIn (${JSON.stringify(me)})`);

  const sessions = await (await get("/api/sessions")).json();
  check(Array.isArray(sessions) && sessions.length > 0, `/api/sessions returned ${sessions.length} rows`);
  console.log("  group     pane     label                      agent   status   reachable transcript");
  for (const s of sessions) {
    console.log(`  ${s.group.padEnd(9)} ${s.paneId.padEnd(8)} ${s.workspaceLabel.padEnd(26)} ${String(s.agent ?? "-").padEnd(7)} ${s.status.padEnd(8)} ${String(s.reachable).padEnd(9)} ${s.transcriptPath ? "found" : "-"}`);
  }

  const claude = sessions.find((s) => s.agent === "claude" && s.transcriptPath && s.status !== "blocked") ?? sessions.find((s) => s.transcriptPath);
  check(Boolean(claude), "a Claude session with a transcript exists");
  if (!claude) return;
  const id = encodeURIComponent(claude.id);
  const page = await (await get(`/api/sessions/${id}/chat?limit=50`)).json();
  const kinds = Array.isArray(page) ? page.reduce((m, e) => ({ ...m, [e.kind]: (m[e.kind] ?? 0) + 1 }), {}) : page;
  check(Array.isArray(page) && page.length > 0, `newest chat page of ${claude.group}/${claude.paneId}: ${page.length} events ${JSON.stringify(kinds)}`);
  if (Array.isArray(page) && page.length) {
    const older = await (await get(`/api/sessions/${id}/chat?limit=50&before=${encodeURIComponent(page[0].uuid)}`)).json();
    const overlap = Array.isArray(older) && older.some((e) => page.some((p) => p.uuid === e.uuid));
    check(Array.isArray(older) && !overlap, `the page before it: ${Array.isArray(older) ? older.length : JSON.stringify(older)} events, none repeated`);
  }
  const blocked = await (await get(`/api/sessions/${id}/blocked`)).json();
  check(typeof blocked.text === "string" && /^[0-9a-f]{12}$/.test(blocked.dialogId), `detection read: ${blocked.text?.length} chars, ${blocked.options?.length} options, dialogId ${blocked.dialogId}`);

  const layoutBefore = await layoutOf(claude.group, claude.paneId);
  const focusBefore = await focusOf(claude.group);
  const rect = layoutBefore.panes.find((p) => p.pane_id === claude.paneId).rect;

  const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws`, { headers: { Cookie: cookie, Origin: ORIGIN } });
  const inbox = [];
  ws.on("message", (d) => inbox.push(JSON.parse(String(d))));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const waitFor = async (pred, label, ms = 10_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const hit = inbox.find(pred);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const first = await waitFor(() => true, "the first message");
  check(first.type === "sessions", `the first WS message is the session list (${first.type})`);

  ws.send(JSON.stringify({ type: "watch_terminal", requestId: "smoke-watch-0001", sessionId: claude.id }));
  const watched = await waitFor((m) => m.type === "command_result" && m.requestId === "smoke-watch-0001", "watch result");
  check(watched.ok === true, `watch_terminal answered ok (${JSON.stringify(watched)})`);
  const live = await waitFor((m) => m.type === "terminal_status" && m.sessionId === claude.id, "terminal status");
  const frame = await waitFor((m) => m.type === "frame" && m.sessionId === claude.id && m.frame.full, "the first full frame");
  console.log(`  first full frame: ${frame.frame.width}x${frame.frame.height} seq ${frame.frame.seq}, ${frame.frame.bytes.length} base64 chars, status ${live.state}`);
  check(frame.frame.width === rect.width && frame.frame.height === rect.height, `frame size equals the pane rect ${rect.width}x${rect.height}`);
  check((await observers(claude.terminalId)).length === 1, "exactly one observer child runs while watched");

  ws.send(JSON.stringify({ type: "unwatch_terminal", requestId: "smoke-unwatch-01", sessionId: claude.id }));
  const unwatched = await waitFor((m) => m.type === "command_result" && m.requestId === "smoke-unwatch-01", "unwatch result");
  check(unwatched.ok === true, "unwatch_terminal answered ok");
  ws.close();
  await new Promise((r) => setTimeout(r, 500));
  check((await observers(claude.terminalId)).length === 0, "no observer child remains after unwatch");

  check(isDeepStrictEqual(await layoutOf(claude.group, claude.paneId), layoutBefore), `herdr pane layout of ${claude.paneId} is identical before and after`);
  check(isDeepStrictEqual(await focusOf(claude.group), focusBefore), "herdr agent focus is identical before and after");
}

try {
  await main();
} catch (e) {
  check(false, `smoke run threw: ${e.message}`);
} finally {
  server.kill("SIGTERM");
  check((await serverExit) === 0, "the server exits 0 on SIGTERM");
  rmSync(state, { recursive: true, force: true });
}
if (failures) {
  console.log(`\n${failures} check(s) failed. Server log:\n${serverLog}`);
  process.exit(1);
}
console.log("\nall checks passed");
