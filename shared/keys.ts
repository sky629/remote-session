/**
 * herdr key names (spec 6.6): one printable character, a special key, a function key or named punctuation,
 * each optionally after ctrl+, alt+ or shift+. The command parser checks the shape; herdr checks the rest.
 */
export const HERDR_KEY =
  /^(?:(?:ctrl|alt|shift)\+)*(?:[!-~]|enter|tab|esc|backspace|left|right|up|down|f(?:[1-9]|1[0-2])|minus|plus|backtick)$/;

/**
 * Every key button on the phone. `bar` is the terminal tab's key row (spec 8.3); `dialog` is the generic set the
 * approval card shows when no option was recognized (spec 5.2). keys.test.ts checks each key against HERDR_KEY.
 */
export const KEY_PRESETS = [
  { label: "Esc", key: "esc", bar: true, dialog: true },
  { label: "Enter", key: "enter", bar: true, dialog: true },
  { label: "Ctrl+C", key: "ctrl+c", bar: true, dialog: false },
  { label: "↑", key: "up", bar: true, dialog: false },
  { label: "↓", key: "down", bar: true, dialog: false },
  { label: "Tab", key: "tab", bar: true, dialog: false },
  { label: "1", key: "1", bar: true, dialog: true },
  { label: "2", key: "2", bar: true, dialog: true },
  { label: "3", key: "3", bar: true, dialog: true },
  { label: "y", key: "y", bar: false, dialog: true },
  { label: "n", key: "n", bar: false, dialog: true },
] as const satisfies readonly { label: string; key: string; bar: boolean; dialog: boolean }[];
