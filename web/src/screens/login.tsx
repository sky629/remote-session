import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { ERROR_INFO } from "#shared/errors";
import { useNow } from "../clock.ts";
import { login } from "../store.ts";

const isStandalone = () =>
  matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

type Notice = { kind: "wrong"; remaining: number } | { kind: "locked"; until: number } | null;

/**
 * Spec 8.0. A visually hidden autocomplete="username" field holds tailscaleLogin, so the iOS keychain saves the
 * passphrase and fills it with Face ID later. Wrong: "암호가 다릅니다. 남은 시도 n회." from `remaining`, the input
 * selected, not cleared. 429: the button counts down `retry_after` and the field is disabled. The standalone banner
 * shows only when display-mode is standalone. Success: navigate to me.next.
 */
export function LoginScreen(props: { tailscaleLogin: string; deviceName: string | null; host: string }): JSX.Element {
  const [value, setValue] = useState("");
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const input = useRef<HTMLInputElement>(null);

  const now = useNow(250, notice?.kind === "locked");
  const secondsLeft = notice?.kind === "locked" ? Math.max(0, Math.ceil((notice.until - now) / 1000)) : 0;
  const locked = notice?.kind === "locked" && secondsLeft > 0;

  // The field is disabled while locked; once the countdown ends it opens again and takes focus.
  useEffect(() => {
    if (notice?.kind === "locked" && !locked) {
      setNotice(null);
      input.current?.focus();
    }
  }, [notice, locked]);

  async function submit(event: Event): Promise<void> {
    event.preventDefault();
    const passphrase = input.current?.value ?? value;
    if (passphrase === "" || busy || locked) return;
    setBusy(true);
    const reply = await login(passphrase);
    setBusy(false);
    if (reply && "error" in reply) {
      if (reply.error === "wrong_passphrase") {
        setNotice({ kind: "wrong", remaining: reply.remaining });
        input.current?.focus();
        input.current?.select();
      } else {
        setNotice({ kind: "locked", until: Date.now() + reply.retry_after * 1000 });
      }
    }
  }

  const gate = [`Tailscale 확인됨 · ${props.tailscaleLogin}`, props.deviceName].filter(Boolean).join(" · ");
  return (
    <form class="login screen" onSubmit={submit} method="post" action="#">
      {isStandalone() && (
        <div class="login__banner">홈 화면 앱은 Safari와 로그인 저장소가 달라서 한 번 더 로그인합니다. 이후에는 유지됩니다.</div>
      )}
      <div class="login__mark" aria-hidden="true">
        ❯_
      </div>
      <h1 class="login__name">세션 콘솔</h1>
      <div class="login__host">{props.host}</div>
      <div class="login__gate">
        <span class="login__dot" />
        <span>{gate}</span>
      </div>
      <input class="visually-hidden" type="text" name="username" autocomplete="username" value={props.tailscaleLogin} readOnly tabIndex={-1} aria-hidden="true" />
      <label class="login__label" for="passphrase">
        암호
      </label>
      <div class={`login__input${notice?.kind === "wrong" ? " login__input--err" : ""}`}>
        <input
          id="passphrase"
          ref={input}
          type={shown ? "text" : "password"}
          name="password"
          autocomplete="current-password"
          autocapitalize="none"
          autocorrect="off"
          spellcheck={false}
          enterkeyhint="go"
          value={value}
          disabled={locked}
          onInput={(e) => setValue(e.currentTarget.value)}
        />
        <button type="button" onClick={() => setShown(!shown)} aria-pressed={shown} disabled={locked}>
          {shown ? "숨기기" : "보기"}
        </button>
      </div>
      {notice?.kind === "wrong" && (
        <p class="login__msg login__msg--err" role="alert">
          {ERROR_INFO.wrong_passphrase.phone} 남은 시도 {notice.remaining}회.
        </p>
      )}
      {locked && (
        <p class="login__msg login__msg--warn" role="alert">
          시도 횟수를 넘었습니다. {secondsLeft}초 뒤에 다시 시도할 수 있습니다.
        </p>
      )}
      {!notice && <p class="login__msg login__msg--hint">이 기기에서 30일 동안 로그인이 유지됩니다.</p>}
      <button class="btn btn--primary" type="submit" disabled={value === "" || busy || locked}>
        {locked ? `${secondsLeft}초 뒤 다시 시도` : busy ? "확인하는 중" : "로그인"}
      </button>
    </form>
  );
}
