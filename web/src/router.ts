import type { SessionId } from "#shared/domain";
import type { Route } from "./store.ts";

/**
 * Paths: /login, /, /s/<source>/<group>/<paneId> with URI-encoded segments (spec 8). The session path carries the
 * source, so it maps one-to-one onto SessionId and a cmux session needs no router change.
 */
export function parseRoute(pathname: string): Route {
  throw new Error("not implemented"); // TODO: session segments → parseSessionId(`${source}:${group}/${pane}`); unknown → sessions
}
export function routePath(route: Route): string {
  throw new Error("not implemented");
}
export function sessionRoute(id: SessionId): Route {
  return { name: "session", sessionId: id };
}
/** pushState (or replaceState) and dispatch. popstate dispatches too, so the iOS swipe back works in standalone mode. */
export function navigate(route: Route, opts?: { replace?: boolean }): void {
  throw new Error("not implemented");
}
