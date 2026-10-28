import type { ChatEvent } from "#shared/domain";

/**
 * One transcript line → chat events (spec 4.4, 6.3). Pure, and the only code that knows the record format.
 * Kept records: type "user" | "assistant", isSidechain !== true, isMeta !== true (skill bodies are isMeta; measured).
 *   user, string content      → USER_WRAPPERS decide: user_text, or dropped
 *   user, text blocks         → user_text (e.g. "[Request interrupted by user]")
 *   user, tool_result blocks  → tool_result; preview = first 200 chars of its text parts; isError = is_error === true
 *   assistant, text           → assistant_text
 *   assistant, tool_use       → tool_use; summary = `${name}: ${TOOL_SUMMARY[name](input)}`, or name alone
 *   assistant, thinking       → dropped
 * A line that does not parse gives [].
 */
export function lineToEvents(line: string): ChatEvent[] {
  throw new Error("not implemented");
}

/**
 * Prefilter before JSON.parse. false means the line cannot be a kept record. Measured on a 27.5 MB transcript:
 * it passes exactly the 1918 user/assistant lines of 10691 and misses none.
 */
export function mayBeChatLine(line: string): boolean {
  return line.includes('"type":"user"') || line.includes('"type":"assistant"');
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** Argument shown after the tool name. Unlisted tools show the name only (spec 6.3). Output is cut to 120 chars. */
export const TOOL_SUMMARY: Readonly<Record<string, (input: Record<string, unknown>) => string | null>> = {
  Bash: (i) => str(i.command)?.split("\n")[0] ?? null,
  Read: (i) => str(i.file_path),
  Edit: (i) => str(i.file_path),
  MultiEdit: (i) => str(i.file_path),
  Write: (i) => str(i.file_path),
  NotebookEdit: (i) => str(i.notebook_path),
  Grep: (i) => str(i.pattern),
  Glob: (i) => str(i.pattern),
  Agent: (i) => str(i.description),
  Task: (i) => str(i.description),
  WebFetch: (i) => str(i.url),
  WebSearch: (i) => str(i.query),
  Skill: (i) => str(i.skill),
};

/** User string records the owner did not type, matched on the leading tag. Unmatched strings are user_text as is. */
export const USER_WRAPPERS: ReadonlyArray<readonly [prefix: string, show: (text: string) => string | null]> = [
  ["<command-name>", (t) => /<command-name>(.*?)<\/command-name>/s.exec(t)?.[1] ?? null], // "/effort"
  ["<local-command-", () => null],
  ["<task-notification>", () => null],
  ["<system-reminder>", () => null],
];
