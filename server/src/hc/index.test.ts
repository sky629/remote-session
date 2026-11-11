import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Session } from "#shared/domain";
import type { InputCommand, RequestId, TerminalState } from "#shared/protocol";
import { createHcSource, keysFor } from "#hc";
import type { SessionSource } from "#source";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/terminal-list.json", import.meta.url), "utf8"));
const dir = mkdtempSync(join(tmpdir(), "sc-hc-"));
type Req = { jsonrpc: string; id: string; method: string; params: Record<string, unknown> };
type Reply = { result: unknown } | { error: { code: number; message: string; data?: { kind: string } } };

/** A fake herdr-core socket: JSON-RPC 2.0, one request per connection. */
async function fakeCore(name: string, reply: (req: Req) => Reply) {
  const path = join(dir, `${name}.sock`);
  const requests: Req[] = [];
  const server = createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d;
      if (!buf.includes("\n")) return;
      const req = JSON.parse(buf.slice(0, buf.indexOf("\n"))) as Req;
      requests.push(req);
      sock.end(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, ...reply(req) })}\n`);
    });
    sock.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(path, r));
  return { path, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const err = (kind: string): Reply => ({ error: { code: -32000, message: kind, data: { kind } } });
let reply: (req: Req) => Reply = (req) => (req.method === "terminal.list" ? { result: fixture } : { result: { turn: 1 } });
const core = await fakeCore("default", (req) => reply(req));

const sources: SessionSource[] = [];
const open = (socketPath = core.path) => {
  const s = createHcSource({ hcBin: "hc", socketPath, callTimeoutMs: 5000, inputTimeoutMs: 5000 });
  sources.push(s);
  return s;
};
after(async () => {
  await Promise.all(sources.map((s) => s.close()));
  await core.close();
});
const asSession = (row: Awaited<ReturnType<SessionSource["poll"]>>["sessions"][number]): Session => ({ ...row, transcriptPath: null });
const cmd = (session: Session, c: { type: InputCommand["type"] } & Record<string, unknown>) =>
  ({ ...c, requestId: "req-00000001" as RequestId, sessionId: session.id }) as InputCommand;
const last = () => ({ method: core.requests.at(-1)?.method, params: core.requests.at(-1)?.params });

test("poll lists this Mac's core as the group `local` with the terminals the Herdr app shows", async () => {
  const { groups, sessions } = await open().poll();
  assert.deepEqual(groups, [{ source: "hc", name: "local", reachable: true }]);
  assert.deepEqual(
    sessions.map((s) => [s.id, s.agent, s.status]),
    [
      ["hc:local/t1c", null, "unknown"],
      ["hc:local/t1n", "claude", "working"],
      ["hc:local/t1p", "claude", "blocked"],
    ],
  );
  assert.equal(core.requests.at(-1)?.jsonrpc, "2.0");
});

test("without a socket file there is no group at all: herdr-core is not running on this Mac", async () => {
  assert.deepEqual(await open(join(dir, "missing.sock")).poll(), { groups: [], sessions: [] });
});

test("a core that stops answering keeps its last rows as unreachable and unknown", async () => {
  const path = join(dir, "flaky.sock");
  const flaky = await fakeCore("flaky", () => ({ result: fixture }));
  const source = open(path);
  assert.equal((await source.poll()).sessions.length, 3);
  await flaky.close();
  writeFileSync(path, ""); // a crashed core leaves its socket file behind, with nobody listening
  const { groups, sessions } = await source.poll();
  assert.deepEqual(groups, [{ source: "hc", name: "local", reachable: false }]);
  assert.ok(sessions.length === 3 && sessions.every((s) => !s.reachable && s.status === "unknown"));
  rmSync(path, { force: true });
});

test("send maps each input to its hc method", async () => {
  const source = open();
  const [, claude] = (await source.poll()).sessions.map(asSession);
  const cases: [name: string, input: InputCommand, method: string, params: object][] = [
    ["prompt", cmd(claude!, { type: "prompt", text: "hello" }), "terminal.send", { terminal: "t1n", text: "hello" }],
    ["keys", cmd(claude!, { type: "keys", keys: ["1"] }), "terminal.keys", { terminal: "t1n", keys: ["1"] }],
    ["raw text goes as one key per character", cmd(claude!, { type: "raw_text", text: "ok Go" }), "terminal.keys", { terminal: "t1n", keys: ["o", "k", "space", "shift+g", "o"] }],
  ];
  for (const [name, input, method, params] of cases) {
    assert.deepEqual(await source.send(claude!, input), { ok: true }, name);
    assert.deepEqual(last(), { method, params }, name);
  }
});

test("raw text with a character hc cannot name is refused before anything is sent", async () => {
  const source = open();
  const [, claude] = (await source.poll()).sessions.map(asSession);
  const before = core.requests.length;
  assert.deepEqual(await source.send(claude!, cmd(claude!, { type: "raw_text", text: "한글" })), { ok: false, error: "raw_text_unsupported" });
  assert.equal(core.requests.length, before);
});

test("keysFor names hc keys: printable ASCII as itself, space and shifted letters by name", () => {
  assert.deepEqual(keysFor("a1./-"), ["a", "1", ".", "/", "-"]);
  assert.deepEqual(keysFor(" A"), ["space", "shift+a"]);
  assert.deepEqual(keysFor(""), []);
  assert.equal(keysFor("한"), null);
  assert.equal(keysFor("a\tb"), null);
});

test("hc error kinds become the console's codes", async () => {
  const source = open();
  const [, claude] = (await source.poll()).sessions.map(asSession);
  const cases: [kind: string, input: InputCommand, expected: string][] = [
    ["blocked", cmd(claude!, { type: "prompt", text: "x" }), "agent_blocked"],
    ["not_found", cmd(claude!, { type: "prompt", text: "x" }), "pane_closed"],
    ["finished", cmd(claude!, { type: "keys", keys: ["enter"] }), "pane_closed"],
    ["unavailable", cmd(claude!, { type: "prompt", text: "x" }), "agent_not_ready"],
    ["invalid_params", cmd(claude!, { type: "raw_text", text: "?" }), "raw_text_unsupported"],
    ["invalid_params", cmd(claude!, { type: "keys", keys: ["bogus"] }), "source_error"],
    ["something_new", cmd(claude!, { type: "prompt", text: "x" }), "source_error"],
  ];
  for (const [kind, input, expected] of cases) {
    reply = (req) => (req.method === "terminal.list" ? { result: fixture } : err(kind));
    assert.deepEqual(await source.send(claude!, input), { ok: false, error: expected }, `${kind} on ${input.type}`);
  }
  reply = (req) => (req.method === "terminal.list" ? { result: fixture } : { result: { turn: 1 } });
});

test("readDialog returns the screen text of terminal.read", async () => {
  const source = open();
  const [, claude] = (await source.poll()).sessions.map(asSession);
  reply = (req) => (req.method === "terminal.list" ? { result: fixture } : { result: { text: "❯ 1. Yes\n  2. No", complete: true, how: "screen" } });
  assert.deepEqual(await source.readDialog(claude!), { ok: true, text: "❯ 1. Yes\n  2. No" });
  assert.deepEqual(last(), { method: "terminal.read", params: { terminal: "t1n", lines: 0 } });
  reply = (req) => (req.method === "terminal.list" ? { result: fixture } : err("not_found"));
  assert.deepEqual(await source.readDialog(claude!), { ok: false, error: "pane_closed" });
  reply = (req) => (req.method === "terminal.list" ? { result: fixture } : { result: { turn: 1 } });
});

test("observing a terminal the list does not know ends at once", async () => {
  const source = open();
  const [, claude] = (await source.poll()).sessions.map(asSession);
  const states: TerminalState[] = [];
  source.observeTerminal({ ...claude!, paneId: "t99" }, { frame: () => assert.fail("no frame"), status: (s) => states.push(s) });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(states, ["ended"]);
});
