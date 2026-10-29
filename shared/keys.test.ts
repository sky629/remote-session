import assert from "node:assert/strict";
import { test } from "node:test";
import { HERDR_KEY, KEY_PRESETS } from "./keys.ts";

test("every key button sends a key name herdr accepts", () => {
  for (const p of KEY_PRESETS) assert.match(p.key, HERDR_KEY, p.label);
});

test("the bar confirms, erases and navigates without digit keys; Ctrl+C alone has a repeat guard", () => {
  assert.deepEqual(KEY_PRESETS.filter((k) => k.bar).map((k) => k.key), ["enter", "backspace", "ctrl+u", "esc", "up", "down", "tab", "ctrl+c"]);
  const dialog = KEY_PRESETS.filter((k) => k.dialog).map((k) => k.key);
  assert.deepEqual(dialog, ["enter", "esc", "y", "n"]);
  assert.deepEqual(KEY_PRESETS.filter((k) => "repeatAfterMs" in k && k.repeatAfterMs).map((k) => k.key), ["ctrl+c"]);
});

test("the key grammar follows spec 6.6", () => {
  for (const k of ["a", "1", "enter", "esc", "ctrl+c", "alt+x", "shift+tab", "f1", "f12", "minus", "backtick"]) {
    assert.match(k, HERDR_KEY, k);
  }
  for (const k of ["", "ctrl+", "enter\n", "hello", "f13", "ctrl+enter+"]) assert.doesNotMatch(k, HERDR_KEY, JSON.stringify(k));
});
