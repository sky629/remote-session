import { parseSessionId } from "#shared/domain";
import type { SessionId } from "#shared/domain";
import { dispatch } from "./store.ts";
import type { Route } from "./store.ts";

/**
 * Paths: /login, /, /s/<source>/<group>/<paneId> with URI-encoded segments (spec 8). The session path carries the
 * source, so it maps one-to-one onto SessionId and a cmux session needs no router change.
 */
export function parseRoute(pathname: string): Route {
  const segments = pathname.split("/").filter((s) => s !== "");
  if (segments.length === 1 && segments[0] === "login") return { name: "login" };
  if (segments.length === 4 && segments[0] === "s") {
    try {
      const [source, group, pane] = segments.slice(1).map(decodeURIComponent);
      const parsed = parseSessionId(`${source}:${group}/${pane}`);
      if (parsed) return { name: "session", sessionId: parsed.id };
    } catch {
      // A malformed escape is an unknown path.
    }
  }
  return { name: "sessions" };
}

export function routePath(route: Route): string {
  switch (route.name) {
    case "login":
      return "/login";
    case "sessions":
      return "/";
    case "session": {
      const parsed = parseSessionId(route.sessionId);
      if (!parsed) return "/";
      return `/s/${[parsed.source, parsed.group, parsed.paneId].map(encodeURIComponent).join("/")}`;
    }
  }
}

export function sessionRoute(id: SessionId): Route {
  return { name: "session", sessionId: id };
}

/** An entry made by navigate() has an app page before it, so back stays inside the app; a deep link entry does not. */
const PUSHED = { pushedByApp: true };

/** pushState (or replaceState) and dispatch. popstate dispatches too, so the iOS swipe back works in standalone mode. */
export function navigate(route: Route, opts?: { replace?: boolean }): void {
  const path = routePath(route);
  if (path !== location.pathname) {
    if (opts?.replace) history.replaceState(null, "", path);
    else history.pushState(PUSHED, "", path);
  }
  dispatch({ type: "route", route });
}

/** The back button of a screen: one step back when the previous entry is ours, otherwise a replace to `fallback`. */
export function goBack(fallback: Route): void {
  if ((history.state as typeof PUSHED | null)?.pushedByApp) history.back();
  else navigate(fallback, { replace: true });
}

/** Takes the route from the address bar and follows the browser's back and forward. Called once, from boot. */
export function startRouter(): void {
  const sync = () => dispatch({ type: "route", route: parseRoute(location.pathname) });
  addEventListener("popstate", sync);
  sync();
}
