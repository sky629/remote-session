import { describe, expect, test } from "vitest";
import type { SessionId } from "#shared/domain";
import { parseRoute, routePath, sessionRoute } from "./router.ts";
import type { Route } from "./store.ts";

const id = (raw: string) => raw as SessionId;

describe("parseRoute and routePath", () => {
  const roundTrips: { name: string; route: Route; path: string }[] = [
    { name: "login", route: { name: "login" }, path: "/login" },
    { name: "sessions", route: { name: "sessions" }, path: "/" },
    { name: "a herdr pane", route: sessionRoute(id("herdr:default/w11:p1")), path: "/s/herdr/default/w11%3Ap1" },
    { name: "a group name with spaces and Korean", route: sessionRoute(id("herdr:내 작업/w1:p2")), path: `/s/herdr/${encodeURIComponent("내 작업")}/w1%3Ap2` },
    { name: "a cmux source", route: sessionRoute(id("cmux:main/p9")), path: "/s/cmux/main/p9" },
  ];
  test.each(roundTrips)("round trip: $name", ({ route, path }) => {
    expect(routePath(route)).toBe(path);
    expect(parseRoute(path)).toEqual(route);
  });

  test("accepts an unescaped colon and a trailing slash", () => {
    expect(parseRoute("/s/herdr/default/w11:p1/")).toEqual(sessionRoute(id("herdr:default/w11:p1")));
  });

  const unknown = ["/nope", "/login/extra", "/s", "/s/herdr", "/s/herdr/default", "/s/herdr/default/w1%3Ap1/extra", "/s/tmux/default/w1%3Ap1", "/s/herdr/a%2Fb/w1", "/s/herdr/%E0%A4%A/w1", "/S/herdr/default/w1"];
  test.each(unknown)("unknown path %s opens the list", (path) => {
    expect(parseRoute(path)).toEqual({ name: "sessions" });
  });
});
