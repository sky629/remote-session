import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { readTerminals, TerminalListError } from "./terminals.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/terminal-list.json", import.meta.url), "utf8"));

test("only live terminals the Herdr app shows become rows, in list order", () => {
  const { rows, size } = readTerminals("local", fixture);
  assert.deepEqual(
    rows.map((r) => r.paneId),
    ["t1c", "t1n", "t1p"],
    "t30 has no herdr.space label (another hc client's terminal) and t20 is finished",
  );
  assert.deepEqual(size.get("t1p"), { cols: 120, rows: 40 });
  assert.equal(size.has("t20"), false);
});

test("a Claude terminal carries the app's where label, its title, the live folder, the status and the agent's pid", () => {
  const [, claude] = readTerminals("local", fixture).rows;
  assert.deepEqual(claude, {
    id: "hc:local/t1n",
    source: "hc",
    group: "local",
    paneId: "t1n",
    terminalId: "t1n",
    workspaceLabel: "payments / 1",
    title: "결제 재시도 정책",
    cwd: "/Users/me/.herdr/worktrees/shop-api/payments",
    agent: "claude",
    claudeSessionId: null,
    stateChangeSeq: 1794309199210,
    reachable: true,
    status: "working",
    agentPid: 78509,
  });
});

test("a shell without a status report is a row without an agent, and it carries no pid", () => {
  const [shell] = readTerminals("local", fixture).rows;
  assert.ok(shell);
  assert.equal(shell.agent, null);
  assert.equal(shell.status, "unknown");
  assert.equal("agentPid" in shell, false);
  assert.equal(shell.title, "me@mac:~/dev/shop-api");
});

test("a terminal without the where label is named after its folder, and an empty title is null", () => {
  const [, , blocked] = readTerminals("local", fixture).rows;
  assert.ok(blocked);
  assert.equal(blocked.workspaceLabel, "review-1");
  assert.equal(blocked.title, null);
  assert.equal(blocked.status, "blocked");
});

test("a status word the console does not know reads as unknown", () => {
  const list = { terminals: [{ ...fixture.terminals[1], status: { app: "claude-code", state: "error" } }] };
  assert.equal(readTerminals("local", list).rows[0]?.status, "unknown");
});

test("another agent keeps its own name", () => {
  const list = { terminals: [{ ...fixture.terminals[1], status: { app: "codex", state: "idle" } }] };
  const [row] = readTerminals("local", list).rows;
  assert.equal(row?.agent, "codex");
  assert.equal("agentPid" in row!, false, "only a Claude pid is worth resolving");
});

test("an unreadable list throws TerminalListError", () => {
  assert.throws(() => readTerminals("local", { terminals: [{ address: 1 }] }), TerminalListError);
  assert.throws(() => readTerminals("local", null), TerminalListError);
});
