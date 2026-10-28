import type { JSX } from "preact";

/** Shell: AuthGate decides the screen from me; ConnectionBanner and ToastHost sit above every screen. */
export function App(): JSX.Element {
  throw new Error("not implemented");
}

/** loading → splash; anonymous → LoginScreen; member → the routed screen. */
export function AuthGate(): JSX.Element {
  throw new Error("not implemented");
}

/** "연결이 끊겼습니다. n초 뒤 다시 시도" counting down to connection.retryAt; hidden while open. */
export function ConnectionBanner(): JSX.Element | null {
  throw new Error("not implemented");
}

export function ToastHost(props: { text: string | null; onDismiss(): void }): JSX.Element | null {
  throw new Error("not implemented");
}
