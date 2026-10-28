import type { JSX } from "preact";

/**
 * Spec 8.0. A visually hidden autocomplete="username" field holds tailscaleLogin, so the iOS keychain saves the
 * passphrase and fills it with Face ID later. Wrong: "암호가 다릅니다. 남은 시도 n회." from `remaining`, the input
 * selected, not cleared. 429: the button counts down `retry_after` and the field is disabled. The standalone banner
 * shows only when display-mode is standalone. Success: navigate to me.next.
 */
export function LoginScreen(props: { tailscaleLogin: string; deviceName: string | null; host: string }): JSX.Element {
  throw new Error("not implemented");
}
