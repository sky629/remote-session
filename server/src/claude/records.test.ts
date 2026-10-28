import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatEvent } from "#shared/domain";
import { lineToEvents, mayBeChatLine } from "./records.ts";

const UUID = "00000000-0000-4000-8000-000000000001";
const TS = "2026-10-28T01:02:03.000Z";

const line = (type: string, content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type, uuid: UUID, timestamp: TS, sessionId: "s", message: { role: type, content }, ...extra });
const userText = (text: string): ChatEvent => ({ kind: "user_text", uuid: UUID, ts: TS, text });
const toolUse = (name: string, summary: string): ChatEvent => ({ kind: "tool_use", uuid: UUID, ts: TS, toolUseId: "tu_1", name, summary });
const use = (name: string, input: unknown) => line("assistant", [{ type: "tool_use", id: "tu_1", name, input }]);

const cases: [name: string, input: string, expected: ChatEvent[]][] = [
  ["user string", line("user", "fix the bug"), [userText("fix the bug")]],
  ["user text block", line("user", [{ type: "text", text: "[Request interrupted by user]" }]), [userText("[Request interrupted by user]")]],
  ["user image block is dropped", line("user", [{ type: "image", source: {} }]), []],
  [
    "tool_result with string content",
    line("user", [{ type: "tool_result", tool_use_id: "tu_9", content: "ok" }]),
    [{ kind: "tool_result", uuid: UUID, ts: TS, toolUseId: "tu_9", isError: false, preview: "ok" }],
  ],
  [
    "tool_result with array content keeps only the text parts",
    line("user", [{ type: "tool_result", tool_use_id: "tu_9", content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }]),
    [{ kind: "tool_result", uuid: UUID, ts: TS, toolUseId: "tu_9", isError: false, preview: "a\nb" }],
  ],
  [
    "tool_result marked as an error",
    line("user", [{ type: "tool_result", tool_use_id: "tu_9", content: "boom", is_error: true }]),
    [{ kind: "tool_result", uuid: UUID, ts: TS, toolUseId: "tu_9", isError: true, preview: "boom" }],
  ],
  [
    "tool_result preview is the first 200 chars",
    line("user", [{ type: "tool_result", tool_use_id: "tu_9", content: "x".repeat(500) }]),
    [{ kind: "tool_result", uuid: UUID, ts: TS, toolUseId: "tu_9", isError: false, preview: "x".repeat(200) }],
  ],
  ["assistant text", line("assistant", [{ type: "text", text: "Done." }]), [{ kind: "assistant_text", uuid: UUID, ts: TS, text: "Done." }]],
  ["thinking is dropped", line("assistant", [{ type: "thinking", thinking: "hmm", signature: "s" }]), []],
  ["Bash shows the first line of the command", use("Bash", { command: "pnpm test\necho done" }), [toolUse("Bash", "Bash: pnpm test")]],
  ["Read", use("Read", { file_path: "/w/a.ts" }), [toolUse("Read", "Read: /w/a.ts")]],
  ["Edit", use("Edit", { file_path: "/w/a.ts", old_string: "a", new_string: "b" }), [toolUse("Edit", "Edit: /w/a.ts")]],
  ["MultiEdit", use("MultiEdit", { file_path: "/w/a.ts", edits: [] }), [toolUse("MultiEdit", "MultiEdit: /w/a.ts")]],
  ["Write", use("Write", { file_path: "/w/b.ts", content: "x" }), [toolUse("Write", "Write: /w/b.ts")]],
  ["NotebookEdit", use("NotebookEdit", { notebook_path: "/w/n.ipynb" }), [toolUse("NotebookEdit", "NotebookEdit: /w/n.ipynb")]],
  ["Grep", use("Grep", { pattern: "TODO" }), [toolUse("Grep", "Grep: TODO")]],
  ["Glob", use("Glob", { pattern: "**/*.ts" }), [toolUse("Glob", "Glob: **/*.ts")]],
  ["Agent", use("Agent", { description: "review the diff", prompt: "..." }), [toolUse("Agent", "Agent: review the diff")]],
  ["Task", use("Task", { description: "find callers" }), [toolUse("Task", "Task: find callers")]],
  ["WebFetch", use("WebFetch", { url: "https://example.com" }), [toolUse("WebFetch", "WebFetch: https://example.com")]],
  ["WebSearch", use("WebSearch", { query: "node test runner" }), [toolUse("WebSearch", "WebSearch: node test runner")]],
  ["Skill", use("Skill", { skill: "tdd" }), [toolUse("Skill", "Skill: tdd")]],
  ["an unlisted tool shows its name only", use("mcp__x__y", { anything: 1 }), [toolUse("mcp__x__y", "mcp__x__y")]],
  ["a listed tool without its argument shows its name only", use("Read", {}), [toolUse("Read", "Read")]],
  ["a summary is cut to 120 chars", use("Bash", { command: "y".repeat(300) }), [toolUse("Bash", `Bash: ${"y".repeat(114)}`)]],
  ["a sidechain record is dropped", line("user", "subagent prompt", { isSidechain: true }), []],
  ["a meta record is dropped", line("user", "skill body", { isMeta: true }), []],
  ["a slash command shows as /name", line("user", "<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args></command-args>"), [userText("/effort")]],
  ["a slash command keeps its arguments", line("user", "<command-name>/model</command-name><command-message>model</command-message><command-args>opus</command-args>"), [userText("/model opus")]],
  ["a slash command led by command-message", line("user", "<command-message>review</command-message>\n<command-name>/review</command-name>"), [userText("/review")]],
  ["shell mode input shows as !command", line("user", "<bash-input>ls -la</bash-input>"), [userText("!ls -la")]],
  ["shell mode output is dropped", line("user", "<bash-stdout>out</bash-stdout><bash-stderr></bash-stderr>"), []],
  ["local command output is dropped", line("user", "<local-command-stdout>x</local-command-stdout>"), []],
  ["local command caveat is dropped", line("user", "<local-command-caveat>x</local-command-caveat>"), []],
  ["task notification is dropped", line("user", "<task-notification><task-id>1</task-id></task-notification>"), []],
  ["system reminder is dropped", line("user", "<system-reminder>x</system-reminder>"), []],
  ["a wrapper in a text block is dropped too", line("user", [{ type: "text", text: "<system-reminder>x</system-reminder>" }]), []],
  ["a pasted block is the owner's text", line("user", '  <pasted_content id="1">log</pasted_content>'), [userText('  <pasted_content id="1">log</pasted_content>')]],
  [
    "one record with several events numbers the later ones",
    line("assistant", [
      { type: "thinking", thinking: "t" },
      { type: "text", text: "Plan." },
      { type: "tool_use", id: "tu_a", name: "Read", input: { file_path: "/w/a" } },
      { type: "tool_use", id: "tu_b", name: "Grep", input: { pattern: "p" } },
    ]),
    [
      { kind: "assistant_text", uuid: UUID, ts: TS, text: "Plan." },
      { kind: "tool_use", uuid: `${UUID}#1`, ts: TS, toolUseId: "tu_a", name: "Read", summary: "Read: /w/a" },
      { kind: "tool_use", uuid: `${UUID}#2`, ts: TS, toolUseId: "tu_b", name: "Grep", summary: "Grep: p" },
    ],
  ],
  ["another record type is dropped", JSON.stringify({ type: "attachment", uuid: UUID, timestamp: TS }), []],
  ["a record without uuid is dropped", JSON.stringify({ type: "user", timestamp: TS, message: { content: "x" } }), []],
  ["an invalid JSON line", '{"type":"user","uuid":', []],
];

for (const [name, input, expected] of cases) {
  test(`lineToEvents: ${name}`, () => assert.deepEqual(lineToEvents(input), expected));
}

test("a summary never ends inside a surrogate pair", () => {
  const [event] = lineToEvents(use("Bash", { command: `${"a".repeat(113)}😀😀` }));
  assert.equal(event?.kind === "tool_use" && event.summary, `Bash: ${"a".repeat(113)}`);
});

test("mayBeChatLine passes user and assistant lines and nothing else", () => {
  for (const [input, expected] of [
    [line("user", "x"), true],
    [line("assistant", []), true],
    [JSON.stringify({ type: "ai-title", aiTitle: "t" }), false],
    [JSON.stringify({ type: "file-history-snapshot" }), false],
  ] as const) {
    assert.equal(mayBeChatLine(input), expected, input);
  }
});
