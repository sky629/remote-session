import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, mock, test } from "node:test";
import type { WebSocket } from "ws";
import { makeSessionId, parseClaudeSessionId } from "#shared/domain";
import type { ChatEvent, ClaudeSessionId, TerminalFrame } from "#shared/domain";
import type { InputCommand, ServerMessage } from "#shared/protocol";
import type { TokenHash } from "#auth";
import { dialogId } from "#claude";
import type { Transcripts } from "#claude";
import { createHub } from "#hub";
import type { Hub } from "#hub";
import { createSessionRegistry } from "#sessions";
import type { SessionSource, SourceSession, TerminalSink } from "#source";

const CID = parseClaudeSessionId("00000000-0000-4000-8000-000000000001")!;
const AGENT = makeSessionId("herdr", "default", "w1:p1");
const DOWN = makeSessionId("herdr", "down", "w9:p1");
const TOKEN = "a".repeat(64) as TokenHash;
const row = (id: typeof AGENT, extra: Partial<SourceSession> = {}): SourceSession =>
  ({
    id,
    source: "herdr",
    group: id.split(":")[1]!.split("/")[0]!,
    paneId: id.split("/")[1]!,
    terminalId: "term_1",
    workspaceLabel: "label",
    title: null,
    cwd: null,
    agent: "claude",
    claudeSessionId: CID,
    stateChangeSeq: 1,
    reachable: true,
    status: "blocked",
    ...extra,
  }) as SourceSession;

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: ServerMessage[] = [];
  closedWith: number | null = null;
  pings = 0;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code: number) {
    this.closedWith = code;
    this.readyState = 3;
    this.emit("close");
  }
  terminate() {
    this.readyState = 3;
    this.emit("close");
  }
  ping() {
    this.pings++;
  }
  /** Sends a command as the phone would, and waits until the hub has answered. */
  async command(cmd: object): Promise<void> {
    const before = this.sent.length;
    this.emit("message", Buffer.from(JSON.stringify(cmd)));
    for (let i = 0; i < 50 && this.sent.length === before && this.readyState === 1; i++) await new Promise((r) => setImmediate(r));
  }
  results() {
    return this.sent.filter((m) => m.type === "command_result");
  }
}

function setup() {
  let dialogText = "❯ 1. Yes\n  2. No";
  const sinks: TerminalSink[] = [];
  const observations: { resyncs: number; closes: number }[] = [];
  const sent: InputCommand[] = [];
  let live = true;
  const source: SessionSource = {
    kind: "herdr",
    poll: async () => ({ groups: [{ source: "herdr", name: "default", reachable: true }], sessions: [row(AGENT), row(DOWN as typeof AGENT, { reachable: false, status: "unknown" })] }),
    send: async (_, input) => {
      sent.push(input);
      return { ok: true };
    },
    readDialog: async () => ({ ok: true, text: dialogText }),
    observeTerminal: (_, sink) => {
      const o = { resyncs: 0, closes: 0 };
      observations.push(o);
      sinks.push(sink);
      return { resync: () => void o.resyncs++, close: () => void o.closes++ };
    },
    close: async () => {},
  };
  let appendListener: (id: ClaudeSessionId, events: ChatEvent[]) => void = () => {};
  const followed: ReadonlySet<ClaudeSessionId>[] = [];
  const transcripts: Transcripts = {
    locate: async () => null,
    page: async () => ({ ok: false, error: "no_transcript" }),
    follow: (ids) => void followed.push(ids),
    onAppend: (l) => {
      appendListener = l;
      return () => {};
    },
  };
  const registry = createSessionRegistry({ sources: [source], transcripts, intervalMs: 60_000 });
  const hub = createHub({ registry, transcripts, sources: { herdr: source }, auth: { isTokenLive: () => live } });
  hubs.push(hub);
  const connect = async () => {
    const ws = new FakeWs();
    hub.attach(ws as unknown as WebSocket, TOKEN);
    await registry.list();
    await new Promise((r) => setImmediate(r));
    return ws;
  };
  return {
    hub,
    registry,
    connect,
    sent,
    sinks,
    observations,
    followed,
    append: (id: ClaudeSessionId, events: ChatEvent[]) => appendListener(id, events),
    revoke: () => (live = false),
    setDialog: (t: string) => (dialogText = t),
  };
}
const hubs: Hub[] = [];
afterEach(() => hubs.splice(0).forEach((h) => h.close()));

let n = 0;
const rid = () => `req-${String(++n).padStart(8, "0")}`;
const frame = (seq: number, full: boolean): TerminalFrame => ({ seq, full, width: 155, height: 54, bytes: "" });

test("attach sends the full list first and turns polling and following on; the last close turns both off", async () => {
  const h = setup();
  const ws = await h.connect();
  assert.equal(ws.sent[0]?.type, "sessions", "the first message is the list");
  const lists = ws.sent.filter((m) => m.type === "sessions");
  assert.deepEqual(lists.at(-1)?.type === "sessions" && lists.at(-1)!.sessions.map((s) => s.id), [AGENT, DOWN]);
  assert.deepEqual([...h.followed.at(-1)!], [CID], "the Claude transcript is followed");
  ws.terminate();
  assert.deepEqual([...h.followed.at(-1)!], [], "nothing followed without clients");
});

test("watch twice gives one observation and a resync; unwatch twice closes it once", async () => {
  const h = setup();
  const ws = await h.connect();
  await ws.command({ type: "watch_terminal", requestId: rid(), sessionId: AGENT });
  await ws.command({ type: "watch_terminal", requestId: rid(), sessionId: AGENT });
  assert.equal(h.observations.length, 1);
  assert.equal(h.observations[0]!.resyncs, 1);
  await ws.command({ type: "unwatch_terminal", requestId: rid(), sessionId: AGENT });
  await ws.command({ type: "unwatch_terminal", requestId: rid(), sessionId: AGENT });
  assert.equal(h.observations[0]!.closes, 1);
  assert.ok(ws.results().every((r) => r.type === "command_result" && r.ok));
});

test("frames and terminal status reach only the client that watches; an ended stream can be watched again", async () => {
  const h = setup();
  const a = await h.connect();
  const b = await h.connect();
  await a.command({ type: "watch_terminal", requestId: rid(), sessionId: AGENT });
  h.sinks[0]!.status("live");
  h.sinks[0]!.frame(frame(1, true));
  assert.deepEqual(a.sent.slice(-2), [
    { type: "terminal_status", sessionId: AGENT, state: "live" },
    { type: "frame", sessionId: AGENT, frame: frame(1, true) },
  ]);
  assert.ok(!b.sent.some((m) => m.type === "frame"));
  h.sinks[0]!.status("ended");
  await a.command({ type: "watch_terminal", requestId: rid(), sessionId: AGENT });
  assert.equal(h.observations.length, 2, "a new observation, not a resync of the ended one");
  a.terminate();
  assert.equal(h.observations[1]!.closes, 1, "closing the socket closes what it opened");
});

test("a resent requestId gets the stored result, even from another socket, and herdr gets the input once", async () => {
  const h = setup();
  const a = await h.connect();
  const cmd = { type: "prompt", requestId: rid(), sessionId: AGENT, text: "hello" };
  await a.command(cmd);
  a.terminate();
  const b = await h.connect();
  await b.command(cmd);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(b.results(), [{ type: "command_result", requestId: cmd.requestId, ok: true }]);
});

test("a guarded key is sent only while the dialog is the one the phone saw", async () => {
  const h = setup();
  const ws = await h.connect();
  const seen = dialogId("❯ 1. Yes\n  2. No");
  await ws.command({ type: "keys", requestId: rid(), sessionId: AGENT, keys: ["1"], guard: { dialogId: seen } });
  assert.equal(h.sent.length, 1);
  h.setDialog("❯ 1. Yes\n  2. Yes, and don't ask again\n  3. No");
  const id = rid();
  await ws.command({ type: "keys", requestId: id, sessionId: AGENT, keys: ["1"], guard: { dialogId: seen } });
  assert.equal(h.sent.length, 1, "no send after the dialog changed");
  assert.deepEqual(ws.results().at(-1), { type: "command_result", requestId: id, ok: false, error: "stale_dialog" });
});

test("commands for unknown or unreachable sessions, and malformed commands, are answered with their error", async () => {
  const h = setup();
  const ws = await h.connect();
  const unknown = rid();
  await ws.command({ type: "prompt", requestId: unknown, sessionId: makeSessionId("herdr", "default", "w404:p1"), text: "x" });
  const down = rid();
  await ws.command({ type: "prompt", requestId: down, sessionId: DOWN, text: "x" });
  const bad = rid();
  await ws.command({ type: "keys", requestId: bad, sessionId: AGENT, keys: ["not a key"] });
  await ws.command({ type: "prompt" });
  assert.deepEqual(ws.results(), [
    { type: "command_result", requestId: unknown, ok: false, error: "pane_closed" },
    { type: "command_result", requestId: down, ok: false, error: "source_unreachable" },
    { type: "command_result", requestId: bad, ok: false, error: "invalid_command" },
  ]);
  assert.equal(h.sent.length, 0);
});

test("a revoked token closes the socket with 4401 on its next command, and on the next heartbeat", async () => {
  const h = setup();
  const a = await h.connect();
  h.revoke();
  await a.command({ type: "prompt", requestId: rid(), sessionId: AGENT, text: "x" });
  assert.equal(a.closedWith, 4401);
  assert.equal(h.sent.length, 0);

  mock.timers.enable({ apis: ["setInterval", "Date"] });
  try {
    const h2 = setup();
    const b = await h2.connect();
    h2.revoke();
    mock.timers.tick(15_000);
    assert.equal(b.closedWith, 4401);
  } finally {
    mock.timers.reset();
  }
});

test("a client that misses two pongs is cut", async () => {
  mock.timers.enable({ apis: ["setInterval", "Date"] });
  try {
    const h = setup();
    const ws = await h.connect();
    mock.timers.tick(15_000);
    mock.timers.tick(15_000);
    assert.equal(ws.readyState, 1, "two pings without pong");
    ws.emit("pong");
    mock.timers.tick(15_000);
    mock.timers.tick(15_000);
    assert.equal(ws.readyState, 1, "a pong resets the count");
    mock.timers.tick(15_000);
    assert.equal(ws.readyState, 3);
  } finally {
    mock.timers.reset();
  }
});

test("frames are dropped while the socket is backed up, and the stream is resynced once it drains", async () => {
  const h = setup();
  const ws = await h.connect();
  await ws.command({ type: "watch_terminal", requestId: rid(), sessionId: AGENT });
  const sink = h.sinks[0]!;
  const frames = () => ws.sent.filter((m) => m.type === "frame").map((m) => m.type === "frame" && m.frame.seq);
  sink.frame(frame(1, true));
  ws.bufferedAmount = 3 * 1024 * 1024;
  sink.frame(frame(2, false));
  ws.bufferedAmount = 0;
  sink.frame(frame(3, false));
  assert.deepEqual(frames(), [1], "the delta after a gap is not sent either");
  assert.equal(h.observations[0]!.resyncs, 1);
  sink.frame(frame(1, true));
  sink.frame(frame(2, false));
  assert.deepEqual(frames(), [1, 1, 2], "the full frame after the resync starts a clean screen");
});

test("appended chat goes to every client for the sessions on that transcript", async () => {
  const h = setup();
  const a = await h.connect();
  const b = await h.connect();
  const events: ChatEvent[] = [{ kind: "user_text", uuid: "u-1", ts: "2026-10-28T00:00:00Z", text: "hi" }];
  h.append(CID, events);
  h.append(parseClaudeSessionId("00000000-0000-4000-8000-0000000000ff")!, events);
  for (const ws of [a, b]) {
    assert.deepEqual(
      ws.sent.filter((m) => m.type === "chat"),
      [AGENT, DOWN].map((sessionId) => ({ type: "chat", sessionId, events })),
      "both rows on that transcript, nothing for an unlisted one",
    );
  }
});
