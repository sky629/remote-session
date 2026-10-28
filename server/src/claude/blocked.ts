import type { BlockedDialog, BlockedOption } from "#shared/domain";

/**
 * Pulls Claude Code's numbered choices out of a dialog's plain text (spec 5.2).
 * Recognized: the last run of consecutive lines shaped `[❯] N. label`, numbered exactly 1..n, n >= 2.
 * Anything else gives [], and the phone shows the generic keys beside the raw text. A wrong [] costs one extra
 * tap; a wrong option answers the dialog wrongly, so any gap or repeat in the numbers rejects the run.
 */
export function parseDialogOptions(text: string): BlockedOption[] {
  // TODO
  //   lines = text.split("\n"); walk up from the bottom to the last line matching
  //     /^\s*[│┃]?\s*(?:❯\s*)?(\d{1,2})[.)]\s+(.+?)\s*[│┃]?\s*$/
  //   extend upward while lines match; numbers must read 1..n top to bottom
  //   key = String(n); label = captured text with box-drawing characters trimmed
  //   fixtures: detection text captured from the console-test session (spec 12.1), one file per dialog kind
  throw new Error("not implemented");
}

/** First 12 hex chars of sha256 over the text with whitespace runs collapsed and trimmed. Same dialog, same id. */
export function dialogId(text: string): string {
  throw new Error("not implemented");
}

export function blockedDialog(text: string): BlockedDialog {
  return { text, options: parseDialogOptions(text), dialogId: dialogId(text) };
}
