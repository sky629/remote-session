import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";

const stateDir = mkdtempSync(join(tmpdir(), "sc-config-"));
process.env.SESSION_CONSOLE_DIR = stateDir;
const { fileCell, PATHS } = await import("#config");

const Schema = z.object({ n: z.number() });

test("SESSION_CONSOLE_DIR moves every state file", () => {
  assert.equal(PATHS.dir, stateDir);
  for (const key of ["config", "tokens", "revokedByCli", "revokedByServer", "logins"] as const) {
    assert.ok(PATHS[key].startsWith(stateDir + "/"), key);
  }
});

test("a missing file reads as the empty value", () => {
  assert.deepEqual(fileCell(join(stateDir, "missing.json"), Schema.nullable(), null).read(), null);
});

test("write then read round-trips, with file mode 0600 inside a 0700 directory", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "sc-cell-")), "nested");
  const path = join(dir, "cell.json");
  const cell = fileCell(path, Schema, { n: 0 });
  await cell.write({ n: 7 });
  assert.deepEqual(cell.read(), { n: 7 });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("a write by another process is seen on the next read", async () => {
  const path = join(stateDir, "shared.json");
  const writer = fileCell(path, Schema, { n: 0 });
  const reader = fileCell(path, Schema, { n: 0 });
  await writer.write({ n: 1 });
  assert.deepEqual(reader.read(), { n: 1 });
  await writer.write({ n: 2 });
  assert.deepEqual(reader.read(), { n: 2 });
});

test("corrupt or off-schema content throws instead of reading as empty", () => {
  for (const [name, content] of [
    ["not json", "{"],
    ["wrong shape", JSON.stringify({ n: "seven" })],
  ] as const) {
    const path = join(stateDir, `bad-${name.replace(" ", "-")}.json`);
    writeFileSync(path, content);
    assert.throws(() => fileCell(path, Schema, { n: 0 }).read(), name);
  }
});
