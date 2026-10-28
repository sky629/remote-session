import type { JSX } from "preact";
import type { Session } from "#shared/domain";
import type { TerminalState } from "#shared/protocol";

/**
 * Mount: frameBus.subscribe, then watchTerminal. Unmount: unwatch, unsubscribe. The effect also re-runs when the
 * connection reopens, because the server dropped this client's observer with the old socket.
 * state "restarting" shows "화면 스트림이 끊겨 다시 엽니다" until "live"; "ended" shows "터미널이 닫혔습니다".
 */
export function TerminalView(props: { session: Session; scale: "fit" | "native"; state: TerminalState }): JSX.Element {
  throw new Error("not implemented");
}

/** The KEY_PRESETS rows with bar: true → sendKeys. Buttons >= 44pt, horizontally scrollable. */
export function KeyBar(props: { onKey(key: string): void; disabled: boolean }): JSX.Element {
  throw new Error("not implemented");
}

/** sendRawText without Enter (spec 5.2); the owner confirms with the Enter key button. */
export function RawTextField(props: { onSend(text: string): void; disabled: boolean }): JSX.Element {
  throw new Error("not implemented");
}
