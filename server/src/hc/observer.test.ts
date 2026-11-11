import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TerminalFrame } from "#shared/domain";
import type { TerminalState } from "#shared/protocol";
import { createObservation } from "#observer";
import { hcDriver } from "./observer.ts";
import type { HcObserverSpec } from "./observer.ts";

const fakeHc = new URL("./fixtures/fake-hc.mjs", import.meta.url).pathname;
const SPEC: HcObserverSpec = { address: "t1n", cols: 166, rows: 43 };

function harness(mode: "hang" | "exit") {
  const logPath = join(mkdtempSync(join(tmpdir(), "sc-hc-observe-")), "log.jsonl");
  process.env.FAKE_MODE = mode;
  process.env.FAKE_LOG = logPath;
  const calls: (TerminalState | TerminalFrame)[] = [];
  let current: HcObserverSpec | null = SPEC;
  const o = createObservation(hcDriver(fakeHc), () => current, { frame: (f) => calls.push(f), status: (s) => calls.push(s) }, () => {});
  return {
    o,
    calls,
    setSpec: (s: HcObserverSpec | null) => (current = s),
    starts: () => (existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[] }) : []),
  };
}

async function until(ok: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!ok()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const text = (f: TerminalFrame) => Buffer.from(f.bytes, "base64").toString("latin1");

test("the child watches without typing, the first chunk is a full frame at the terminal's size and later chunks continue it", async (t) => {
  const h = harness("hang");
  t.after(() => h.o.close());
  await until(() => h.calls.length >= 3, "two frames");
  assert.deepEqual(h.starts()[0]?.args, ["attach", "--observe", "t1n"]);
  const [live, first, second] = h.calls as [TerminalState, TerminalFrame, TerminalFrame];
  assert.equal(live, "live");
  assert.deepEqual({ seq: first.seq, full: first.full, width: first.width, height: first.height }, { seq: 1, full: true, width: 166, height: 43 });
  assert.ok(text(first).startsWith("\x18\x1b[!p"), "the repaint's reset sequence is passed through untouched");
  assert.deepEqual({ seq: second.seq, full: second.full, text: text(second) }, { seq: 2, full: false, text: "\r\nmore" });
});

test("a stream that ends because the terminal finished restarts, and ends for good once the terminal is gone from the list", async (t) => {
  const h = harness("exit");
  t.after(() => h.o.close());
  await until(() => h.calls.includes("restarting"), "restart after exit");
  h.setSpec(null);
  await until(() => h.calls.includes("ended"), "ended");
  assert.deepEqual(h.calls.filter((c) => typeof c === "string"), ["live", "restarting", "ended"]);
});
