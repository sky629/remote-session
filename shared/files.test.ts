import assert from "node:assert/strict";
import { test } from "node:test";
import { fileName, viewableType } from "./files.ts";

test("viewableType: by extension, case-insensitive, nothing else", () => {
  assert.equal(viewableType("/out/report.html"), "text/html; charset=utf-8");
  assert.equal(viewableType("/out/Shot.PNG"), "image/png");
  assert.equal(viewableType("/out/notes.md"), null);
  assert.equal(viewableType("/out/.html"), null, "a dot file has no extension");
  assert.equal(viewableType("/out/archive.html/"), null);
  assert.equal(viewableType("/out/noext"), null);
});

test("fileName is the last path segment", () => {
  assert.equal(fileName("/a/b/c.html"), "c.html");
  assert.equal(fileName("c.html"), "c.html");
});
