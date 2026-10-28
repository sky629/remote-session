import assert from "node:assert/strict";
import { test } from "node:test";
import { makeSessionId, parseClaudeSessionId, parseSessionId } from "./domain.ts";

test("a session id round-trips through the URL form", () => {
  const id = makeSessionId("herdr", "default", "w11:p1");
  assert.deepEqual(parseSessionId(id), { id, source: "herdr", group: "default", paneId: "w11:p1" });
});

test("ids from outside are rejected unless they have the exact shape", () => {
  for (const raw of ["", "herdr:default", "tmux:default/w1:p1", "herdr:a/b/c", "herdr:/w1:p1"]) {
    assert.equal(parseSessionId(raw), null, raw);
  }
});

test("only a lowercase UUID becomes a Claude session id, so it is safe as a file name", () => {
  assert.ok(parseClaudeSessionId("f2e47829-9e38-414c-811f-395503e66ba8"));
  for (const raw of ["../../etc/passwd", "F2E47829-9E38-414C-811F-395503E66BA8", "f2e47829-9e38-414c-811f-395503e66ba8.jsonl", 42]) {
    assert.equal(parseClaudeSessionId(raw), null, String(raw));
  }
});
