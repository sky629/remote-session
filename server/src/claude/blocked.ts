import { createHash } from "node:crypto";
import type { BlockedDialog, BlockedOption } from "#shared/domain";

/**
 * Pulls Claude Code's numbered choices out of a dialog's plain text (spec 5.2).
 * Recognized: the last run of option lines shaped `[❯] N. label`, numbered exactly 1..n, n >= 2, with the ❯
 * selection marker on exactly one of them. A line indented deeper than the option's number continues that option's
 * label (a wrapped label, or a question option's description). Box borders (│ ┃) are ignored.
 * Anything else gives [], and the phone shows the generic keys beside the raw text. A wrong [] costs one extra
 * tap; a wrong option answers the dialog wrongly, so any gap or repeat in the numbers rejects the run, and the
 * marker requirement keeps a numbered list in Claude's prose from ever becoming buttons.
 */
export function parseDialogOptions(text: string): BlockedOption[] {
  let run: Option[] = [];
  let last: Option[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "").replace(/^(\s*)[│┃]/, "$1 ").replace(/[│┃]\s*$/, "").trimEnd();
    const m = OPTION.exec(line);
    const prev = run.at(-1);
    if (m) {
      run.push({ n: Number(m[3]), marked: m[2] !== undefined, column: m[1]!.length + (m[2]?.length ?? 0), label: m[4]! });
    } else if (prev && line.trim() && indent(line) > prev.column) {
      prev.label = `${prev.label} ${line.trim()}`;
    } else if (run.length) {
      last = run;
      run = [];
    }
  }
  if (run.length) last = run;
  const valid = last.length >= 2 && last.every((o, i) => o.n === i + 1) && last.filter((o) => o.marked).length === 1;
  return valid ? last.map((o) => ({ key: String(o.n), label: o.label })) : [];
}

interface Option {
  n: number;
  marked: boolean;
  /** Column of the number, so continuation lines can be told from the next paragraph. */
  column: number;
  label: string;
}

const OPTION = /^(\s*)(❯\s*)?(\d{1,2})[.)]\s+(\S.*)$/;
const indent = (line: string): number => line.length - line.trimStart().length;

/** First 12 hex chars of sha256 over the text with whitespace runs collapsed and trimmed. Same dialog, same id. */
export function dialogId(text: string): string {
  return createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 12);
}

export function blockedDialog(text: string): BlockedDialog {
  return { text, options: parseDialogOptions(text), dialogId: dialogId(text) };
}
