import type { ChatEvent } from "#shared/domain";

/**
 * One transcript line → chat events (spec 4.4, 6.3). Pure, and the only code that knows the record format.
 * Kept records: type "user" | "assistant", isSidechain !== true, isMeta !== true (skill bodies are isMeta; measured).
 *   user, string content      → USER_WRAPPERS decide: user_text, or dropped
 *   user, text blocks         → user_text (e.g. "[Request interrupted by user]"), through USER_WRAPPERS as well
 *   user, tool_result blocks  → tool_result; preview = first 200 chars of its text parts; isError = is_error === true
 *   assistant, text           → assistant_text
 *   assistant, tool_use       → tool_use; summary = `${name}: ${TOOL_SUMMARY[name](input)}`, or name alone
 *   assistant, thinking       → dropped, like every other block type (image, server_tool_use, ...)
 * A line that does not parse gives [].
 */
export function lineToEvents(line: string): ChatEvent[] {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isObject(record) || record.isSidechain === true || record.isMeta === true) return [];
  const uuid = str(record.uuid);
  const ts = str(record.timestamp);
  const content = isObject(record.message) ? record.message.content : undefined;
  if (!uuid || !ts) return [];
  const pieces = record.type === "user" ? userPieces(content) : record.type === "assistant" ? assistantPieces(content) : [];
  return pieces.map((p, i): ChatEvent => ({ ...p, uuid: i === 0 ? uuid : `${uuid}#${i}`, ts }));
}

type Piece = DistributiveOmit<ChatEvent, "uuid" | "ts">;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function userPieces(content: unknown): Piece[] {
  if (typeof content === "string") return userText(content);
  if (!Array.isArray(content)) return [];
  return content.flatMap((b): Piece[] => {
    if (!isObject(b)) return [];
    if (b.type === "text" && typeof b.text === "string") return userText(b.text);
    if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
      return [{ kind: "tool_result", toolUseId: b.tool_use_id, isError: b.is_error === true, preview: cut(resultText(b.content), 200) }];
    }
    return [];
  });
}

function userText(raw: string): Piece[] {
  const lead = raw.trimStart();
  const wrapper = USER_WRAPPERS.find(([prefix]) => lead.startsWith(prefix));
  const text = wrapper ? wrapper[1](lead) : raw;
  return text ? [{ kind: "user_text", text }] : [];
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((p) => (isObject(p) && p.type === "text" && typeof p.text === "string" ? [p.text] : [])).join("\n");
}

function assistantPieces(content: unknown): Piece[] {
  if (typeof content === "string") return content ? [{ kind: "assistant_text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((b): Piece[] => {
    if (!isObject(b)) return [];
    if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) return [{ kind: "assistant_text", text: b.text }];
    if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
      const arg = TOOL_SUMMARY[b.name]?.(isObject(b.input) ? b.input : {});
      return [{ kind: "tool_use", toolUseId: b.id, name: b.name, summary: cut(arg ? `${b.name}: ${arg}` : b.name, 120) }];
    }
    return [];
  });
}

/** At most n UTF-16 units, never ending inside a surrogate pair. */
function cut(s: string, n: number): string {
  const head = s.slice(0, n);
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

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

const tag = (name: string, t: string): string | null => new RegExp(`<${name}>(.*?)</${name}>`, "s").exec(t)?.[1]?.trim() || null;
const slashCommand = (t: string): string | null => {
  const name = tag("command-name", t);
  const args = tag("command-args", t);
  return name && args ? `${name} ${args}` : name;
};

/**
 * User strings the owner did not type as a message, matched on the leading tag after leading whitespace.
 * Unmatched strings are user_text as is. Measured over 536 local transcripts: slash commands lead with either
 * <command-name> or <command-message>; `!` shell mode records <bash-input> and then its output as <bash-stdout>.
 */
export const USER_WRAPPERS: ReadonlyArray<readonly [prefix: string, show: (text: string) => string | null]> = [
  ["<command-name>", slashCommand], // "/effort high"
  ["<command-message>", slashCommand],
  ["<bash-input>", (t) => {
    const command = tag("bash-input", t);
    return command ? `!${command}` : null;
  }],
  ["<bash-stdout>", () => null],
  ["<bash-stderr>", () => null],
  ["<local-command-", () => null],
  ["<task-notification>", () => null],
  ["<system-reminder>", () => null],
];
