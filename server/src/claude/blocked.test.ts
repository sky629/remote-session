import assert from "node:assert/strict";
import { test } from "node:test";
import { blockedDialog, dialogId, parseDialogOptions } from "./blocked.ts";

// Synthetic dialogs in the shape Claude Code draws them. Replace with detection text captured from the
// console-test session (spec 12.1) once it exists.
const permission = (marker: 1 | 2 | 3) =>
  [
    "✻ Working on the probe file",
    "",
    "╭────────────────────────────────────────────────────╮",
    "│ Bash command                                       │",
    "│                                                    │",
    "│   touch probe.txt                                  │",
    "│   Create an empty probe file                       │",
    "│                                                    │",
    "│ Do you want to proceed?                            │",
    `│ ${marker === 1 ? "❯" : " "} 1. Yes                                         │`,
    `│ ${marker === 2 ? "❯" : " "} 2. Yes, and don't ask again for touch commands │`,
    "│      in /tmp/console-test                          │",
    `│ ${marker === 3 ? "❯" : " "} 3. No, and tell Claude what to do differently  │`,
    "│      (esc)                                         │",
    "╰────────────────────────────────────────────────────╯",
  ].join("\n");

const permissionOptions = [
  { key: "1", label: "Yes" },
  { key: "2", label: "Yes, and don't ask again for touch commands in /tmp/console-test" },
  { key: "3", label: "No, and tell Claude what to do differently (esc)" },
];

const question = [
  " ☐ Library",
  "",
  "Which date library should we use?",
  "",
  "❯ 1. date-fns",
  "     Modular functions",
  "  2. dayjs",
  "     Small, moment-like API",
  "  3. Type something.",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
].join("\n");

const cases: [name: string, text: string, expected: ReturnType<typeof parseDialogOptions>][] = [
  ["permission dialog, cursor on 1", permission(1), permissionOptions],
  ["permission dialog, cursor on 2", permission(2), permissionOptions],
  ["permission dialog, cursor on 3", permission(3), permissionOptions],
  [
    "two-option dialog without a box",
    ["Do you want to make this edit to a.ts?", "❯ 1. Yes", "  2. No, and tell Claude what to do differently (esc)"].join("\n"),
    [
      { key: "1", label: "Yes" },
      { key: "2", label: "No, and tell Claude what to do differently (esc)" },
    ],
  ],
  [
    "question dialog with descriptions under each option",
    question,
    [
      { key: "1", label: "date-fns Modular functions" },
      { key: "2", label: "dayjs Small, moment-like API" },
      { key: "3", label: "Type something." },
    ],
  ],
  ["a numbered list in Claude's prose", ["Here is the plan:", "1. Refactor the parser", "2. Add tests", "3. Run the suite"].join("\n"), []],
  ["a gap in the numbering", ["❯ 1. Yes", "  2. Maybe", "  4. No"].join("\n"), []],
  ["numbering that does not start at 1", ["❯ 2. Yes", "  3. No"].join("\n"), []],
  ["a repeated number", ["❯ 1. Yes", "  1. No"].join("\n"), []],
  ["a single option", ["❯ 1. Continue"].join("\n"), []],
  ["two selection markers", ["❯ 1. Yes", "❯ 2. No"].join("\n"), []],
  ["no text at all", "", []],
  [
    "only the last run counts, so an earlier list cannot leak in",
    ["❯ 1. Old", "  2. Older", "", "Next:", "1. a", "2. b"].join("\n"),
    [],
  ],
];

for (const [name, text, expected] of cases) {
  test(`parseDialogOptions: ${name}`, () => assert.deepEqual(parseDialogOptions(text), expected));
}

test("dialogId ignores whitespace changes and nothing else", () => {
  const id = dialogId(permission(1));
  assert.match(id, /^[0-9a-f]{12}$/);
  assert.equal(dialogId(permission(1).replace(/ {2,}/g, " ").replace(/\n/g, "\r\n")), id, "rewrapped whitespace");
  assert.equal(dialogId(`\n\n${permission(1)}   \n`), id, "leading and trailing blank lines");
  assert.notEqual(dialogId(permission(2)), id, "cursor moved");
  assert.notEqual(dialogId(permission(1).replace("probe.txt", "other.txt")), id, "different command");
});

test("blockedDialog bundles text, options and id", () => {
  const text = permission(1);
  assert.deepEqual(blockedDialog(text), { text, options: permissionOptions, dialogId: dialogId(text) });
});
