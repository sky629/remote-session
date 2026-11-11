import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createClaudeProcesses } from "./processes.ts";

const dir = mkdtempSync(join(tmpdir(), "sc-procs-"));
const ID = "a8dd827a-f079-40b6-bac8-f8b606a132ed";
writeFileSync(join(dir, "78509.json"), JSON.stringify({ pid: 78509, sessionId: ID, cwd: "/w", startedAt: 1, status: "busy" }));
writeFileSync(join(dir, "124.json"), JSON.stringify({ pid: 999, sessionId: ID }));
writeFileSync(join(dir, "125.json"), "{not json");
writeFileSync(join(dir, "126.json"), JSON.stringify({ pid: 126, sessionId: "not-a-uuid" }));
const processes = createClaudeProcesses(dir);

test("the session id comes from the record named after the pid", async () => {
  assert.equal(await processes.sessionIdOf(78509), ID);
});

test("a record naming another pid, a broken file, a bad id, a missing file or a bad pid all read as null", async () => {
  for (const pid of [124, 125, 126, 127, 0, -1, 1.5, Number.NaN]) assert.equal(await processes.sessionIdOf(pid), null, String(pid));
});
