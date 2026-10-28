import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Session } from "#shared/domain";
import type { ErrorCode } from "#shared/errors";
import type { InputCommand, RequestId, TerminalState } from "#shared/protocol";
import { createHerdrSource } from "#herdr";
import type { SessionSource } from "#source";

const fixtureSnapshot = JSON.parse(readFileSync(new URL("./fixtures/snapshot.json", import.meta.url), "utf8")).result.snapshot;
const fakeHerdr = new URL("./fixtures/fake-herdr.mjs", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "sc-herdr-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Req = { id: string; method: string; params: Record<string, unknown> };
/** A fake herdr session socket: one request per connection; `reply` returns the body, or null to hang up. */
async function fakeSession(name: string, reply: (req: Req) => object | null) {
  const path = join(dir, `${name}.sock`);
  const requests: Req[] = [];
  const server = createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d;
      if (!buf.includes("\n")) return;
      const req = JSON.parse(buf.slice(0, buf.indexOf("\n"))) as Req;
      requests.push(req);
      const body = reply(req);
      if (body) sock.end(`${JSON.stringify({ id: req.id, ...body })}\n`);
      else sock.end();
    });
    sock.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(path, r));
  return { path, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const sessionList = (entries: { name: string; path: string; running?: boolean }[]) =>
  JSON.stringify({ sessions: entries.map((e) => ({ name: e.name, running: e.running ?? true, socket_path: e.path, default: e.name === "default", session_dir: dir })) });
const snapshotReply = (snapshot: unknown) => ({ result: { type: "session_snapshot", snapshot } });
const empty = { panes: [], agents: [], workspaces: [], layouts: [], tabs: [] };

let defaultReply: (req: Req) => object | null = (req) => (req.method === "session.snapshot" ? snapshotReply(fixtureSnapshot) : { result: { type: "ok" } });
const def = await fakeSession("default", (req) => defaultReply(req));
const rocket = await fakeSession("rocket", () => snapshotReply(empty));
process.env.FAKE_SESSIONS = sessionList([
  { name: "default", path: def.path },
  { name: "rocket", path: rocket.path },
  { name: "stopped", path: join(dir, "stopped.sock"), running: false },
]);

const sources: SessionSource[] = [];
const open = (relistMs = 60_000) => {
  const s = createHerdrSource({ herdrBin: fakeHerdr, callTimeoutMs: 15_000, relistMs });
  sources.push(s);
  return s;
};
after(async () => {
  await Promise.all(sources.map((s) => s.close()));
  await Promise.all([def.close(), rocket.close()]);
});
const asSession = (row: Awaited<ReturnType<SessionSource["poll"]>>["sessions"][number]): Session => ({ ...row, transcriptPath: null });

test("poll lists every running herdr session as a group, empty ones included, and one row per pane", async () => {
  const { groups, sessions } = await open().poll();
  assert.deepEqual(groups, [
    { source: "herdr", name: "default", reachable: true },
    { source: "herdr", name: "rocket", reachable: true },
  ]);
  assert.equal(sessions.length, 7);
  assert.ok(sessions.every((s) => s.group === "default" && s.reachable));
});

test("send maps each input to its herdr method and params", async () => {
  const source = open();
  const rows = (await source.poll()).sessions;
  const agent = asSession(rows.find((r) => r.agent)!);
  const bare = asSession(rows.find((r) => !r.agent)!);
  const cmd = (c: { type: InputCommand["type"] } & Record<string, unknown>) => ({ ...c, requestId: "req-00000001" as RequestId, sessionId: agent.id }) as InputCommand;
  const cases: [name: string, session: Session, input: InputCommand, method: string, params: object][] = [
    ["prompt", agent, cmd({ type: "prompt", text: "hello" }), "agent.prompt", { target: agent.paneId, text: "hello" }],
    ["keys to an agent", agent, cmd({ type: "keys", keys: ["1"] }), "agent.send_keys", { target: agent.paneId, keys: ["1"] }],
    ["keys to a pane without an agent", bare, cmd({ type: "keys", keys: ["ctrl+c"] }), "pane.send_keys", { pane_id: bare.paneId, keys: ["ctrl+c"] }],
    ["raw text, never with Enter", agent, cmd({ type: "raw_text", text: "use X" }), "pane.send_text", { pane_id: agent.paneId, text: "use X" }],
  ];
  for (const [name, session, input, method, params] of cases) {
    assert.deepEqual(await source.send(session, input), { ok: true }, name);
    assert.deepEqual({ method: def.requests.at(-1)?.method, params: def.requests.at(-1)?.params }, { method, params }, name);
  }
});

test("herdr errors and lost replies become console error codes, by call kind", async () => {
  const source = open();
  const row = asSession((await source.poll()).sessions.find((r) => r.agent)!);
  const prompt = { type: "prompt", text: "x", requestId: "req-00000002", sessionId: row.id } as InputCommand;
  const cases: [herdr: string | null, send: ErrorCode, read: ErrorCode][] = [
    ["agent_blocked", "agent_blocked", "agent_blocked"],
    ["agent_not_ready", "agent_not_ready", "agent_not_ready"],
    ["agent_prompt_stalled", "delivery_unconfirmed", "delivery_unconfirmed"],
    ["agent_not_found", "source_error", "source_error"],
    [null, "delivery_unconfirmed", "source_unreachable"],
  ];
  try {
    for (const [code, send, read] of cases) {
      defaultReply = () => (code ? { error: { code, message: "m" } } : null);
      assert.deepEqual(await source.send(row, prompt), { ok: false, error: send }, `send ${code}`);
      assert.deepEqual(await source.readDialog(row), { ok: false, error: read }, `read ${code}`);
    }
  } finally {
    defaultReply = (req) => (req.method === "session.snapshot" ? snapshotReply(fixtureSnapshot) : { result: { type: "ok" } });
  }
});

test("readDialog reads the detection source as plain text", async () => {
  const source = open();
  const row = asSession((await source.poll()).sessions[0]!);
  defaultReply = (req) => (req.method === "agent.read" ? { result: { type: "pane_read", read: { text: "❯ 1. Yes\n  2. No" } } } : snapshotReply(fixtureSnapshot));
  assert.deepEqual(await source.readDialog(row), { ok: true, text: "❯ 1. Yes\n  2. No" });
  assert.deepEqual(def.requests.at(-1)?.params, { target: row.paneId, source: "detection", format: "text", strip_ansi: true });
});

test("a group that stops answering keeps its last rows, as unreachable and unknown", async () => {
  const flaky = await fakeSession("flaky", (req) => (req.method === "session.snapshot" ? snapshotReply(fixtureSnapshot) : null));
  process.env.FAKE_SESSIONS = sessionList([{ name: "flaky", path: flaky.path }]);
  try {
    const source = open();
    assert.ok((await source.poll()).sessions.every((s) => s.reachable));
    await flaky.close();
    const { groups, sessions } = await source.poll();
    assert.deepEqual(groups, [{ source: "herdr", name: "flaky", reachable: false }]);
    assert.equal(sessions.length, 7);
    assert.ok(sessions.every((s) => !s.reachable && s.status === "unknown"));
  } finally {
    process.env.FAKE_SESSIONS = sessionList([{ name: "default", path: def.path }, { name: "rocket", path: rocket.path }]);
  }
});

test("the session list is read again after relistMs, and vanished groups disappear", async () => {
  const source = open(0);
  assert.equal((await source.poll()).groups.length, 2);
  process.env.FAKE_SESSIONS = sessionList([{ name: "default", path: def.path }]);
  try {
    await sleep(5);
    assert.deepEqual((await source.poll()).groups.map((g) => g.name), ["default"]);
  } finally {
    process.env.FAKE_SESSIONS = sessionList([{ name: "default", path: def.path }, { name: "rocket", path: rocket.path }]);
  }
});

test("an observation opens at the pane's rect in its herdr session and ends when the pane is gone", async () => {
  const log = join(dir, "observe.jsonl");
  process.env.FAKE_MODE = "hang";
  process.env.FAKE_LOG = log;
  const source = open();
  const row = asSession((await source.poll()).sessions[0]!);
  const states: TerminalState[] = [];
  source.observeTerminal(row, { frame: () => {}, status: (s) => states.push(s) });
  for (let i = 0; i < 1500 && !states.includes("live"); i++) await sleep(10);
  const start = JSON.parse(readFileSync(log, "utf8").split("\n")[0]!);
  assert.deepEqual(start.args, ["--session", "default", "terminal", "session", "observe", row.terminalId, "--cols", "155", "--rows", "54"]);
  defaultReply = (req) => (req.method === "session.snapshot" ? snapshotReply(empty) : { result: { type: "ok" } });
  try {
    await source.poll();
    assert.deepEqual(states, ["live", "ended"]);
  } finally {
    defaultReply = (req) => (req.method === "session.snapshot" ? snapshotReply(fixtureSnapshot) : { result: { type: "ok" } });
  }
  for (let i = 0; i < 1000 && !readFileSync(log, "utf8").includes("sigterm"); i++) await sleep(10);
  assert.ok(existsSync(log) && readFileSync(log, "utf8").includes("sigterm"), "the child got SIGTERM");
});
