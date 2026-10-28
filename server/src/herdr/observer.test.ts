import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TerminalFrame } from "#shared/domain";
import type { TerminalState } from "#shared/protocol";
import { createObservation } from "./observer.ts";
import type { ObserverSpec } from "./observer.ts";

const fakeHerdr = new URL("./fixtures/fake-observe.mjs", import.meta.url).pathname;
type LogEntry = { event: "start" | "sigterm"; pid: number; at: number; args?: string[] };

function harness(mode: "hang" | "exit" | "crash" | "closed", initial: ObserverSpec | null = { group: "default", terminalId: "term_1", cols: 155, rows: 54 }) {
  const logPath = join(mkdtempSync(join(tmpdir(), "sc-observe-")), "log.jsonl");
  process.env.FAKE_MODE = mode;
  process.env.FAKE_LOG = logPath;
  const calls: (TerminalState | TerminalFrame)[] = [];
  let ended = 0;
  let current = initial;
  const o = createObservation(fakeHerdr, () => current, { frame: (f) => calls.push(f), status: (s) => calls.push(s) }, () => ended++);
  return {
    o,
    calls,
    ended: () => ended,
    setSpec: (s: ObserverSpec | null) => (current = s),
    log: (): LogEntry[] => (existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []),
  };
}

async function until(ok: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!ok()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frame = (seq: number, full: boolean, width = 155, height = 54): TerminalFrame => ({ seq, full, width, height, bytes: Buffer.from(`screen ${seq}`).toString("base64") });
const starts = (h: ReturnType<typeof harness>) => h.log().filter((e) => e.event === "start");

test("frames pass through at the pane size after a live status, and close sends SIGTERM and silences the sink", async () => {
  const h = harness("hang");
  await until(() => h.calls.length >= 2, "first frame");
  assert.deepEqual(h.calls, ["live", frame(1, true)]);
  assert.deepEqual(starts(h)[0]?.args, ["--session", "default", "terminal", "session", "observe", "term_1", "--cols", "155", "--rows", "54"]);
  h.o.close();
  h.o.close();
  await until(() => h.log().some((e) => e.event === "sigterm"), "SIGTERM");
  await sleep(100);
  assert.equal(h.ended(), 1, "onEnd runs once");
  assert.equal(h.calls.length, 2, "no sink calls after close");
});

test("a child that exits is restarted, and the restarted stream reports live again", async () => {
  const h = harness("exit");
  await until(() => h.calls.filter((c) => c === "live").length >= 2, "second live");
  assert.deepEqual(h.calls.slice(0, 5), ["live", frame(1, true), frame(2, false), "restarting", "live"]);
  h.o.close();
});

test("restarts back off, doubling from 250 ms while no frame arrives", async () => {
  const h = harness("crash");
  await until(() => starts(h).length >= 4, "four starts");
  h.o.close();
  const at = starts(h).map((e) => e.at);
  const gaps = at.slice(1).map((t, i) => t - at[i]!);
  assert.ok(gaps[0]! >= 240, `first retry after ~250 ms, got ${gaps[0]}`);
  assert.ok(gaps[1]! >= 490, `second retry after ~500 ms, got ${gaps[1]}`);
  assert.ok(gaps[2]! >= 990, `third retry after ~1000 ms, got ${gaps[2]}`);
  assert.ok(h.calls.every((c) => c === "restarting"));
});

test("terminal.closed is treated as an exit: the child is stopped and a new one starts", async () => {
  const h = harness("closed");
  await until(() => starts(h).length >= 2, "restart after terminal.closed");
  assert.ok(h.log().some((e) => e.event === "sigterm" && e.pid === starts(h)[0]!.pid), "the first child was stopped");
  assert.deepEqual(h.calls.slice(0, 3), ["live", frame(1, true), "restarting"]);
  h.o.close();
});

test("sync restarts only when the pane size changed, and ends when the terminal is gone", async () => {
  const h = harness("hang");
  await until(() => h.calls.length >= 2, "first frame");
  h.o.sync();
  await sleep(100);
  assert.equal(starts(h).length, 1, "same spec, same child");
  h.setSpec({ group: "default", terminalId: "term_1", cols: 100, rows: 30 });
  h.o.sync();
  await until(() => h.calls.length >= 5, "frame at the new size");
  assert.deepEqual(h.calls.slice(2), ["restarting", "live", frame(1, true, 100, 30)]);
  assert.ok(h.log().some((e) => e.event === "sigterm"), "the old child was stopped");
  h.setSpec(null);
  h.o.sync();
  assert.equal(h.calls.at(-1), "ended");
  assert.equal(h.ended(), 1);
});

test("resync restarts the stream so the next frame is full", async () => {
  const h = harness("hang");
  await until(() => h.calls.length >= 2, "first frame");
  h.o.resync();
  await until(() => h.calls.length >= 4, "frame after resync");
  assert.deepEqual(h.calls.slice(2), ["live", frame(1, true)]);
  assert.equal(starts(h).length, 2);
  h.o.close();
});

test("a terminal missing from the start ends after observeTerminal has returned", async () => {
  const h = harness("hang", null);
  assert.deepEqual(h.calls, [], "nothing synchronous");
  await sleep(0);
  assert.deepEqual(h.calls, ["ended"]);
  assert.equal(h.ended(), 1);
  assert.equal(starts(h).length, 0);
});
