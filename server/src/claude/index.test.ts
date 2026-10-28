import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseClaudeSessionId } from "#shared/domain";
import type { ChatEvent, ClaudeSessionId } from "#shared/domain";
import { createTranscripts } from "#claude";

// Synthetic transcripts only: every line below is made up for the test.
const record = (i: number, text = `message ${i}`) =>
  JSON.stringify({ type: i % 2 ? "assistant" : "user", uuid: `u-${i}`, timestamp: `2026-10-28T00:00:${String(i % 60).padStart(2, "0")}Z`, message: { content: i % 2 ? [{ type: "text", text }] : text } }) + "\n";
const noise = (i: number) => JSON.stringify({ type: "file-history-snapshot", messageId: `m-${i}`, snapshot: { blob: "z".repeat(120) } }) + "\n";
const lines = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => record(from + k)).join("");
const ids = (events: ChatEvent[]) => events.map((e) => e.uuid);
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => `u-${from + k}`);

let n = 0;
function project(content: string): { root: string; id: ClaudeSessionId; file: string } {
  const root = mkdtempSync(join(tmpdir(), "sc-transcripts-"));
  const id = parseClaudeSessionId(`00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`)!;
  mkdirSync(join(root, "-work-project"));
  const file = join(root, "-work-project", `${id}.jsonl`);
  writeFileSync(file, content);
  return { root, id, file };
}

async function until<T>(read: () => T, ok: (v: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const v = read();
    if (ok(v)) return v;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("the newest page comes from the tail, and older pages walk back to the file start", async () => {
  const { root, id } = project(lines(0, 10));
  const t = createTranscripts(root);
  assert.deepEqual(await t.page(id, null, 3).then((r) => r.ok && ids(r.events)), range(7, 10));
  assert.deepEqual(await t.page(id, "u-7", 3).then((r) => r.ok && ids(r.events)), range(4, 7));
  assert.deepEqual(await t.page(id, "u-1", 3).then((r) => r.ok && ids(r.events)), ["u-0"]);
});

test("paging backward across many 256 KiB blocks returns every event once, in order", async () => {
  const content = Array.from({ length: 4000 }, (_, i) => record(i) + noise(i)).join("");
  assert.ok(content.length > 4 * 256 * 1024, "the file spans several blocks");
  const { root, id } = project(content);
  const t = createTranscripts(root);
  const pages: string[][] = [];
  for (let before: string | null = null; ; ) {
    const r = await t.page(id, before, 50);
    assert.ok(r.ok);
    pages.unshift(ids(r.events));
    if (r.events.length < 50) break;
    before = r.events[0]!.uuid;
  }
  assert.deepEqual(pages.flat(), range(0, 4000));
});

test("a line longer than one block is read whole", async () => {
  const long = "L".repeat(700 * 1024);
  const { root, id } = project(lines(0, 5) + record(5, long) + lines(6, 11));
  const r = await createTranscripts(root).page(id, null, 50);
  assert.ok(r.ok);
  assert.deepEqual(ids(r.events), range(0, 11));
  const big = r.events[5];
  assert.equal(big?.kind === "assistant_text" && big.text.length, long.length);
});

test("a half-written last line waits until it is complete, then follow pushes each event exactly once", async () => {
  const last = record(3);
  const { root, id, file } = project(lines(0, 3) + last.slice(0, 20));
  const t = createTranscripts(root);
  const pushed: string[] = [];
  t.onAppend((cid, events) => cid === id && pushed.push(...ids(events)));
  assert.deepEqual(await t.page(id, null, 10).then((r) => r.ok && ids(r.events)), range(0, 3));
  t.follow(new Set([id]));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(pushed, [], "nothing is pushed for the half line");
  appendFileSync(file, last.slice(20));
  await until(() => pushed, (p) => p.length >= 1, "the completed line");
  for (let i = 4; i < 9; i++) appendFileSync(file, record(i));
  await until(() => pushed, (p) => p.length >= 6, "appended lines");
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(pushed, range(3, 9));
  assert.deepEqual(await t.page(id, null, 50).then((r) => r.ok && ids(r.events)), range(0, 9));
  t.follow(new Set());
});

test("a file that shrinks is reopened, and appends to the new content are pushed", async () => {
  const { root, id, file } = project(lines(0, 20));
  const t = createTranscripts(root);
  const pushed: string[] = [];
  t.onAppend((_, events) => pushed.push(...ids(events)));
  t.follow(new Set([id]));
  await t.page(id, null, 5);
  writeFileSync(file, record(100));
  await new Promise((r) => setTimeout(r, 200));
  appendFileSync(file, record(101));
  await until(() => pushed, (p) => p.includes("u-101"), "the append after the replacement");
  assert.deepEqual(await t.page(id, null, 50).then((r) => r.ok && ids(r.events)), ["u-100", "u-101"]);
  t.follow(new Set());
});

test("a cursor that is not in the file is stale, and a missing file is no_transcript", async () => {
  const { root, id } = project(lines(0, 5));
  const t = createTranscripts(root);
  assert.deepEqual(await t.page(id, "u-999", 10), { ok: false, error: "stale_cursor" });
  const other = parseClaudeSessionId("00000000-0000-4000-8000-ffffffffffff")!;
  assert.deepEqual(await t.page(other, null, 10), { ok: false, error: "no_transcript" });
});

test("locate finds the newest copy and ignores paths that resolve outside the root", async () => {
  const { root, id, file } = project(lines(0, 1));
  const t = createTranscripts(root);
  assert.equal(await t.locate(id), realpathSync(file), "the realpath, which is what gets read");

  mkdirSync(join(root, "-work-moved"));
  const newer = join(root, "-work-moved", `${id}.jsonl`);
  writeFileSync(newer, lines(0, 1));
  utimesSync(file, new Date(1_000_000), new Date(1_000_000));
  assert.equal(await createTranscripts(root).locate(id), realpathSync(newer));

  const outside = mkdtempSync(join(tmpdir(), "sc-outside-"));
  const escaped = parseClaudeSessionId("00000000-0000-4000-8000-eeeeeeeeeeee")!;
  writeFileSync(join(outside, `${escaped}.jsonl`), lines(0, 1));
  symlinkSync(outside, join(root, "-linked-dir"));
  symlinkSync(join(outside, `${escaped}.jsonl`), join(root, "-work-project", `${escaped}.jsonl`));
  assert.equal(await createTranscripts(root).locate(escaped), null);
});
