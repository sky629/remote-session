import type { JSX } from "preact";
import { useEffect } from "preact/hooks";
import { useNow } from "./clock.ts";
import { LoginScreen } from "./screens/login.tsx";
import { SessionScreen } from "./screens/session.tsx";
import { SessionsScreen } from "./screens/sessions.tsx";
import { dispatch, state } from "./store.ts";
import type { AppState } from "./store.ts";
import { chatAvailable, groupSessions } from "./view.ts";
import { useVisualViewport } from "./viewport.ts";

const TOAST_MS = 5000;

const bannerVisible = (s: AppState) => s.me.status === "member" && s.connection.status === "closed";

/** Shell: AuthGate decides the screen from me; ConnectionBanner and ToastHost sit above every screen. */
export function App(): JSX.Element {
  const s = state.value;
  const banner = bannerVisible(s);
  useVisualViewport();
  useEffect(() => {
    document.documentElement.toggleAttribute("data-banner", banner);
  }, [banner]);
  return (
    <>
      <ConnectionBanner />
      <AuthGate />
      <ToastHost text={s.ui.toast} onDismiss={() => dispatch({ type: "toast", text: null })} />
    </>
  );
}

/** loading → splash; anonymous → LoginScreen; member → the routed screen. */
export function AuthGate(): JSX.Element {
  const s = state.value;
  if (s.me.status === "loading") {
    return (
      <div class="screen splash">
        <div class="login__mark">❯_</div>
        <div class="login__name">세션 콘솔</div>
        <div>연결하는 중입니다.</div>
      </div>
    );
  }
  if (s.me.status === "anonymous") {
    return <LoginScreen tailscaleLogin={s.me.tailscaleLogin} deviceName={s.me.deviceName} host={location.host} />;
  }
  const route = s.ui.route;
  if (route.name === "session") {
    const row = s.sessions === null ? "loading" : (s.sessions.byId.get(route.sessionId) ?? "gone");
    const opensOnChat = row === "loading" || (row !== "gone" && chatAvailable(row));
    return <SessionScreen session={row} tab={s.ui.tab.get(route.sessionId) ?? (opensOnChat ? "chat" : "term")} />;
  }
  const groups = s.sessions === null ? [] : groupSessions(s.sessions.groups, s.sessions.byId.values());
  return <SessionsScreen groups={groups} loading={s.sessions === null} />;
}

/** "연결이 끊겼습니다. n초 뒤 다시 시도" counting down to connection.retryAt; hidden while open. */
export function ConnectionBanner(): JSX.Element | null {
  const s = state.value;
  const visible = bannerVisible(s);
  const now = useNow(1000, visible);
  if (!visible || s.connection.status !== "closed") return null;
  const seconds = Math.ceil((s.connection.retryAt - now) / 1000);
  return (
    <div class="banner" role="status">
      {seconds > 0 ? `연결이 끊겼습니다. ${seconds}초 뒤 다시 시도합니다.` : "연결이 끊겼습니다. 다시 연결하는 중입니다."}
    </div>
  );
}

export function ToastHost(props: { text: string | null; onDismiss(): void }): JSX.Element | null {
  const { text, onDismiss } = props;
  useEffect(() => {
    if (text === null) return;
    const id = setTimeout(onDismiss, TOAST_MS);
    return () => clearTimeout(id);
  }, [text]);
  if (text === null) return null;
  return (
    <div class="toast" role="status" onClick={onDismiss}>
      {text}
    </div>
  );
}
