import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { makeSessionId, parseClaudeSessionId } from "#shared/domain";
import type { ClaudeSessionId, Session, SessionGroup } from "#shared/domain";
import { createSessionRegistry, diffSessions } from "#sessions";
import type { SessionSource, SourcePoll, SourceSession } from "#source";

const CID = parseClaudeSessionId("00000000-0000-4000-8000-000000000001")!;
const row = (pane: string, extra: Partial<SourceSession> = {}): SourceSession =>
  ({
    id: makeSessionId("herdr", "default", pane),
    source: "herdr",
    group: "default",
    paneId: pane,
    terminalId: `term_${pane}`,
    workspaceLabel: "label",
    title: null,
    cwd: null,
    agent: null,
    claudeSessionId: null,
    stateChangeSeq: 0,
    reachable: true,
    status: "unknown",
    ...extra,
  }) as SourceSession;
const GROUPS: SessionGroup[] = [{ source: "herdr", name: "default", reachable: true }];

/** A source whose polls can be held open, to put a poll in flight at a chosen moment. */
function fakeSource() {
  const held: (() => void)[] = [];
  const state = { polls: 0, hold: false, rows: [row("w1:p1")] as SourceSession[], groups: GROUPS };
  const source: SessionSource = {
    kind: "herdr",
    poll() {
      state.polls++;
      const result = (): SourcePoll => ({ groups: state.groups, sessions: state.rows });
      if (!state.hold) return Promise.resolve(result());
      return new Promise((resolve) => held.push(() => resolve(result())));
    },
    send: async () => ({ ok: true }),
    readDialog: async () => ({ ok: true, text: "" }),
    observeTerminal: () => ({ resync() {}, close() {} }),
    close: async () => {},
  };
  return { source, state, release: () => held.splice(0).forEach((r) => r()) };
}

const located = (id: ClaudeSessionId) => Promise.resolve(id === CID ? "/projects/x/session.jsonl" : null);
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 }));
afterEach(() => mock.timers.reset());

test("turning on polls at once and then every interval; turning off stops; both are idempotent", async () => {
  const f = fakeSource();
  const reg = createSessionRegistry({ sources: [f.source], transcripts: { locate: located }, intervalMs: 1500 });
  reg.setActive(true);
  reg.setActive(true);
  await flush();
  assert.equal(f.state.polls, 1, "polls at once, one chain");
  mock.timers.tick(1500);
  await flush();
  assert.equal(f.state.polls, 2);
  reg.setActive(false);
  reg.setActive(false);
  mock.timers.tick(10_000);
  await flush();
  assert.equal(f.state.polls, 2, "no poll while off");
});

test("a poll in flight when polling turns off still applies its result, and nothing is scheduled after it", async () => {
  const f = fakeSource();
  const reg = createSessionRegistry({ sources: [f.source], transcripts: { locate: located }, intervalMs: 1500 });
  const seen: number[] = [];
  reg.subscribe((list) => seen.push(list.sessions.length));
  f.state.hold = true;
  reg.setActive(true);
  await flush();
  reg.setActive(false);
  f.release();
  await flush();
  assert.equal(reg.current().sessions.length, 1, "the result applied");
  assert.deepEqual(seen, [1]);
  mock.timers.tick(10_000);
  await flush();
  assert.equal(f.state.polls, 1);
});

test("off then on during a poll leaves exactly one poll chain", async () => {
  const f = fakeSource();
  const reg = createSessionRegistry({ sources: [f.source], transcripts: { locate: located }, intervalMs: 1500 });
  f.state.hold = true;
  reg.setActive(true);
  await flush();
  reg.setActive(false);
  reg.setActive(true);
  await flush();
  assert.equal(f.state.polls, 1, "turning on again joins the poll in flight");
  f.state.hold = false;
  f.release();
  await flush();
  for (let i = 2; i <= 4; i++) {
    mock.timers.tick(1500);
    await flush();
    assert.equal(f.state.polls, i, `one poll per interval, round ${i}`);
  }
  reg.setActive(false);
  mock.timers.tick(10_000);
  await flush();
  assert.equal(f.state.polls, 4, "no second chain survives turning off");
});

test("list() polls only when the last poll is older than the interval, and concurrent callers share one poll", async () => {
  const f = fakeSource();
  const reg = createSessionRegistry({ sources: [f.source], transcripts: { locate: located }, intervalMs: 1500 });
  const [a, b] = await Promise.all([reg.list(), reg.list()]);
  assert.equal(f.state.polls, 1);
  assert.equal(a, b);
  await reg.list();
  assert.equal(f.state.polls, 1, "fresh enough");
  mock.timers.tick(1500);
  await reg.list();
  assert.equal(f.state.polls, 2);
});

test("listeners hear only polls that changed rows or groups, and Claude rows get their transcript path", async () => {
  const f = fakeSource();
  const reg = createSessionRegistry({ sources: [f.source], transcripts: { locate: located }, intervalMs: 1500 });
  const diffs: unknown[] = [];
  reg.subscribe((_, diff) => diffs.push(diff));
  const poll = async () => {
    mock.timers.tick(1500);
    await reg.list();
  };
  await poll();
  await poll();
  assert.equal(diffs.length, 1, "an identical poll is silent");
  f.state.rows = [row("w1:p1", { agent: "claude", claudeSessionId: CID, status: "working", stateChangeSeq: 3 }), row("w2:p1")];
  await poll();
  assert.deepEqual(diffs.at(-1), { added: [makeSessionId("herdr", "default", "w2:p1")], removed: [], changed: [makeSessionId("herdr", "default", "w1:p1")] });
  assert.equal(reg.get(makeSessionId("herdr", "default", "w1:p1"))?.transcriptPath, "/projects/x/session.jsonl");
  assert.equal(reg.get(makeSessionId("herdr", "default", "w2:p1"))?.transcriptPath, null);
  f.state.groups = [...GROUPS, { source: "herdr", name: "rocket", reachable: true }];
  await poll();
  assert.deepEqual(diffs.at(-1), { added: [], removed: [], changed: [] }, "a group change alone is heard");
});

test("diffSessions compares every field", () => {
  const base = { ...row("w1:p1"), transcriptPath: null } as Session;
  const prev = new Map([[base.id, base]]);
  assert.deepEqual(diffSessions(prev, [base]), { added: [], removed: [], changed: [] });
  assert.deepEqual(diffSessions(prev, [{ ...base, title: "t" }]).changed, [base.id]);
  assert.deepEqual(diffSessions(prev, []).removed, [base.id]);
});
