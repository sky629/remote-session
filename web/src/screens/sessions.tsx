import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Session } from "#shared/domain";
import type { LoginRecord } from "#shared/protocol";
import { api } from "../api.ts";
import { useNow } from "../clock.ts";
import { navigate, routePath, sessionRoute } from "../router.ts";
import { logout, state } from "../store.ts";
import { STATUS_VIEW, relativeTime, shortPath } from "../view.ts";
import type { GroupView } from "../view.ts";

const SKELETON_ROWS = 5;

/** Header with "N 작업 중" and the menu (이 기기 로그아웃, 모든 기기 로그아웃, 로그인 기록); groups from groupSessions. */
export function SessionsScreen(props: { groups: GroupView[]; loading: boolean }): JSX.Element {
  const [menu, setMenu] = useState<"closed" | "menu" | "history">("closed");
  const working = props.groups.reduce((n, g) => n + g.sessions.filter((s) => s.status === "working").length, 0);

  const pick = (action: () => void) => () => {
    setMenu("closed");
    action();
  };
  return (
    <div class="screen">
      <header class="header">
        <h1 class="header__title">세션</h1>
        {working > 0 && <span class="pill pill--info">{working} 작업 중</span>}
        <button class="icon-btn" type="button" aria-label="메뉴" aria-expanded={menu === "menu"} onClick={() => setMenu(menu === "menu" ? "closed" : "menu")}>
          ⋯
        </button>
      </header>
      {menu === "menu" && (
        <>
          <button class="backdrop" type="button" aria-label="메뉴 닫기" onClick={() => setMenu("closed")} />
          <div class="menu" role="menu">
            <button class="menu__item" role="menuitem" type="button" onClick={pick(() => void logout("this"))}>
              이 기기 로그아웃
            </button>
            <button
              class="menu__item"
              role="menuitem"
              type="button"
              onClick={pick(() => {
                if (confirm("모든 기기에서 로그아웃합니다. 계속할까요?")) void logout("all");
              })}
            >
              모든 기기 로그아웃
            </button>
            <button class="menu__item" role="menuitem" type="button" onClick={() => setMenu("history")}>
              로그인 기록
            </button>
          </div>
        </>
      )}
      {menu === "history" && <LoginHistorySheet onClose={() => setMenu("closed")} />}
      <div class="list">
        {props.loading
          ? Array.from({ length: SKELETON_ROWS }, (_, i) => <div class="skeleton" key={i} aria-hidden="true" />)
          : props.groups.map((view) => <SessionGroupView key={`${view.group.source}:${view.group.name}`} view={view} />)}
      </div>
    </div>
  );
}

/** Label "herdr · default"; "응답 없음" when the group is unreachable; an empty group says it has no panes. */
export function SessionGroupView(props: { view: GroupView }): JSX.Element {
  const { view } = props;
  const since = state.value.statusSince;
  return (
    <>
      <div class="group-label">
        <span>{view.label}</span>
        {!view.group.reachable && <span class="group-label__state">응답 없음</span>}
      </div>
      {view.sessions.length === 0 ? (
        <div class="empty">실행 중인 에이전트가 없습니다</div>
      ) : (
        view.sessions.map((s) => <SessionRow key={s.id} session={s} since={since.get(s.id) ?? null} />)
      )}
    </>
  );
}

/** Height >= 64pt. Blocked rows get the warning border. Tap → navigate(sessionRoute(id)). */
export function SessionRow(props: { session: Session; since: number | null }): JSX.Element {
  const { session: s, since } = props;
  const route = sessionRoute(s.id);
  const now = useNow(30_000, since !== null);
  return (
    <a
      class={`row${s.status === "blocked" ? " row--blocked" : ""}`}
      href={routePath(route)}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(route);
      }}
    >
      <span class="row__label">{s.workspaceLabel}</span>
      <span class="row__side">
        {since !== null && <span class="row__time">{relativeTime(since, now)}</span>}
        <StatusPill session={s} />
      </span>
      <span class="row__sub">{s.title ?? (s.agent === null ? "에이전트 없음" : s.agent)}</span>
      {s.cwd !== null && <span class="row__path">{shortPath(s.cwd)}</span>}
    </a>
  );
}

/** Label and tone from STATUS_VIEW. An unreachable row reads "확인 불가" by type, so no extra case exists here. */
export function StatusPill(props: { session: Session }): JSX.Element {
  const view = STATUS_VIEW[props.session.status];
  return <span class={`pill pill--${view.tone}`}>{view.label}</span>;
}

const loginTime = new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

/** The 20 latest attempts from GET /api/logins: time, ok, device. */
export function LoginHistorySheet(props: { onClose(): void }): JSX.Element {
  const [records, setRecords] = useState<LoginRecord[] | null>(null);
  useEffect(() => {
    let live = true;
    void api("GET /api/logins", {}).then((r) => {
      if (live && r) setRecords(r);
    });
    return () => {
      live = false;
    };
  }, []);
  return (
    <>
      <button class="backdrop backdrop--dim" type="button" aria-label="로그인 기록 닫기" onClick={props.onClose} />
      <section class="sheet" role="dialog" aria-label="로그인 기록">
        <div class="sheet__head">
          <h2>로그인 기록</h2>
          <button class="icon-btn" type="button" aria-label="닫기" onClick={props.onClose}>
            ✕
          </button>
        </div>
        <div class="sheet__body">
          {records === null ? (
            <p class="login__msg login__msg--hint">불러오는 중입니다.</p>
          ) : records.length === 0 ? (
            <p class="login__msg login__msg--hint">기록이 없습니다.</p>
          ) : (
            <ul class="history">
              {records.map((r) => (
                <li key={r.ts}>
                  <span class={r.ok ? "history__ok" : "history__fail"}>{r.ok ? "성공" : "실패"}</span>
                  <span>{loginTime.format(new Date(r.ts))}</span>
                  <span class="history__meta">
                    {r.device} · {r.tailscaleLogin}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </>
  );
}
