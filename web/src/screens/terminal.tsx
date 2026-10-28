import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Session } from "#shared/domain";
import { KEY_PRESETS } from "#shared/keys";
import type { TerminalState } from "#shared/protocol";
import { frameBus } from "../connection.ts";
import { dispatch, sendKeys, sendRawText, state as store, unwatchTerminal, watchTerminal } from "../store.ts";
import { createTerminalSurface } from "../xterm.ts";
import type { TerminalSurface } from "../xterm.ts";

const STREAM_NOTICE: Partial<Record<TerminalState, string>> = {
  restarting: "화면 스트림이 끊겨 다시 엽니다.",
  ended: "터미널이 닫혔습니다.",
};

/**
 * Mount: frameBus.subscribe, then watchTerminal. Unmount: unwatch, unsubscribe. The effect also re-runs when the
 * connection reopens, because the server dropped this client's observer with the old socket.
 * state "restarting" shows "화면 스트림이 끊겨 다시 엽니다" until "live"; "ended" shows "터미널이 닫혔습니다".
 */
export function TerminalView(props: { session: Session; scale: "fit" | "native"; state: TerminalState }): JSX.Element {
  const { session, scale, state: stream } = props;
  const host = useRef<HTMLDivElement>(null);
  const surface = useRef<TerminalSurface | null>(null);
  const open = store.value.connection.status === "open";
  const size = store.value.terminal.get(session.id);
  const hasFrame = size !== undefined && size.width > 0;

  // The surface and its subscription come first: the first full frame follows the watch command at once.
  useEffect(() => {
    const created = createTerminalSurface(host.current!);
    surface.current = created;
    const unsubscribe = frameBus.subscribe(session.id, (frame) => created.apply(frame));
    return () => {
      unsubscribe();
      created.dispose();
      surface.current = null;
    };
  }, [session.id]);

  useEffect(() => {
    surface.current?.setScale(scale);
  }, [scale, session.id]);

  useEffect(() => {
    if (!open) return;
    watchTerminal(session.id);
    return () => unwatchTerminal(session.id);
  }, [session.id, open]);

  const notice = STREAM_NOTICE[stream];
  return (
    <div class="term-view">
      <div class="term-tools">
        <span class="term-tools__status">{notice ?? (hasFrame ? `${size.width}×${size.height}` : "")}</span>
        <button class="toggle" type="button" aria-pressed={scale === "native"} onClick={() => dispatch({ type: "term_scale", scale: scale === "fit" ? "native" : "fit" })}>
          원래 크기
        </button>
      </div>
      <div class="term-box">
        <div class="term-host" ref={host} data-scale={scale} />
        {!hasFrame && <div class="term-host__empty">{open ? "화면을 불러오는 중입니다." : "연결되면 화면을 불러옵니다."}</div>}
      </div>
      <KeyBar onKey={(key) => sendKeys(session.id, [key])} disabled={!open || stream === "ended"} />
      <RawTextField onSend={(text) => sendRawText(session.id, text)} disabled={!open || stream === "ended"} />
    </div>
  );
}

/** The KEY_PRESETS rows with bar: true → sendKeys. Buttons >= 44pt, horizontally scrollable. */
export function KeyBar(props: { onKey(key: string): void; disabled: boolean }): JSX.Element {
  return (
    <div class="keybar" role="toolbar" aria-label="키 입력">
      {KEY_PRESETS.filter((k) => k.bar).map((k) => (
        <button class="btn" type="button" key={k.key} disabled={props.disabled} onClick={() => props.onKey(k.key)}>
          {k.label}
        </button>
      ))}
    </div>
  );
}

/** sendRawText without Enter (spec 5.2); the owner confirms with the Enter key button. */
export function RawTextField(props: { onSend(text: string): void; disabled: boolean }): JSX.Element {
  const [text, setText] = useState("");
  return (
    <form
      class="rawtext"
      onSubmit={(e) => {
        e.preventDefault();
        if (text === "" || props.disabled) return;
        props.onSend(text);
        setText("");
      }}
    >
      <input
        type="text"
        value={text}
        placeholder="글자 입력 (Enter 없이 보냄)"
        aria-label="터미널에 보낼 글자"
        autocapitalize="none"
        autocorrect="off"
        spellcheck={false}
        enterkeyhint="send"
        disabled={props.disabled}
        onInput={(e) => setText(e.currentTarget.value)}
      />
      <button class="btn btn--primary" type="submit" disabled={props.disabled || text === ""}>
        보내기
      </button>
    </form>
  );
}
