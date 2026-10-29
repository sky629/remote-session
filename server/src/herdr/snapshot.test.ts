import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { readSnapshot, SnapshotError } from "./snapshot.ts";

// A real `session.snapshot` reply from herdr 0.9.5 (protocol 22) with ids, titles, labels and paths replaced.
const reply = JSON.parse(readFileSync(new URL("./fixtures/snapshot.json", import.meta.url), "utf8"));
const snapshot = () => structuredClone(reply.result.snapshot);

test("every pane becomes one row, agent or not", () => {
  const { rows } = readSnapshot("default", snapshot());
  assert.equal(rows.length, 7);
  assert.deepEqual(rows[1], {
    id: "herdr:default/w2:p1",
    source: "herdr",
    group: "default",
    paneId: "w2:p1",
    terminalId: "term_00000000000002",
    workspaceLabel: "label-2",
    title: "title 2",
    cwd: "/work/project-2",
    agent: "claude",
    claudeSessionId: "00000000-0000-4000-8000-000000000002",
    stateChangeSeq: 228,
    reachable: true,
    status: "working",
  });
});

test("a pane without an agent has status unknown, no Claude id and sequence 0", () => {
  const row = readSnapshot("default", snapshot()).rows.find((r) => r.paneId === "w7:p1");
  assert.deepEqual(
    row && { agent: row.agent, status: row.status, claudeSessionId: row.claudeSessionId, stateChangeSeq: row.stateChangeSeq },
    { agent: null, status: "unknown", claudeSessionId: null, stateChangeSeq: 0 },
  );
});

test("sizes come from the layout rect, keyed by terminal id", () => {
  const { size } = readSnapshot("default", snapshot());
  assert.equal(size.size, 7);
  for (const s of size.values()) assert.deepEqual(s, { cols: 155, rows: 54 });
  const s = snapshot();
  s.layouts[0].panes[0].rect = { width: 80, height: 24, x: 0, y: 0 };
  assert.deepEqual(readSnapshot("default", s).size.get("term_00000000000001"), { cols: 80, rows: 24 });
});

test("the Claude session id is kept only when it is a Claude agent with a UUID session", () => {
  const cases: [name: string, edit: (agent: Record<string, unknown>) => void, expected: string | null][] = [
    ["claude with an id session", () => {}, "00000000-0000-4000-8000-000000000001"],
    ["another agent kind", (a) => (a.agent = "codex"), null],
    ["a session that is not an id", (a) => ((a.agent_session as { kind: string }).kind = "path"), null],
    ["a value that is not a UUID", (a) => ((a.agent_session as { value: string }).value = "../../etc/passwd"), null],
    ["no session at all", (a) => delete a.agent_session, null],
  ];
  for (const [name, edit, expected] of cases) {
    const s = snapshot();
    edit(s.agents[0]);
    assert.equal(readSnapshot("default", s).rows[0]!.claudeSessionId, expected, name);
  }
});

test("a status herdr may add later reads as unknown", () => {
  const s = snapshot();
  s.agents[0].agent_status = "sleeping";
  assert.equal(readSnapshot("default", s).rows[0]!.status, "unknown");
});

test("a shape it cannot read throws SnapshotError", () => {
  for (const [name, input] of [
    ["undefined", undefined],
    ["no panes", { ...snapshot(), panes: undefined }],
    ["pane without terminal id", { ...snapshot(), panes: [{ pane_id: "w1:p1", workspace_id: "w1" }] }],
  ] as const) {
    assert.throws(() => readSnapshot("default", input), SnapshotError, name);
  }
});
