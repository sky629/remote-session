import type { JSX } from "preact";
import type { Session } from "#shared/domain";
import type { GroupView } from "../view.ts";

/** Header with "N 작업 중" and the menu (이 기기 로그아웃, 모든 기기 로그아웃, 로그인 기록); groups from groupSessions. */
export function SessionsScreen(props: { groups: GroupView[]; loading: boolean }): JSX.Element {
  throw new Error("not implemented");
}
/** Label "herdr · default"; "응답 없음" when the group is unreachable; an empty group says it has no panes. */
export function SessionGroupView(props: { view: GroupView }): JSX.Element {
  throw new Error("not implemented");
}
/** Height >= 64pt. Blocked rows get the warning border. Tap → navigate(sessionRoute(id)). */
export function SessionRow(props: { session: Session; since: number | null }): JSX.Element {
  throw new Error("not implemented");
}
/** Label and tone from STATUS_VIEW. An unreachable row reads "확인 불가" by type, so no extra case exists here. */
export function StatusPill(props: { session: Session }): JSX.Element {
  throw new Error("not implemented");
}
/** The 20 latest attempts from GET /api/logins: time, ok, device. */
export function LoginHistorySheet(props: { onClose(): void }): JSX.Element {
  throw new Error("not implemented");
}
