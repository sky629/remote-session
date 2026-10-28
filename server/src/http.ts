import type { IncomingMessage, Server } from "node:http";
import type { z } from "zod";
import { ERROR_INFO } from "#shared/errors";
import type { ErrorCode } from "#shared/errors";
import type { ApiContract, ApiRes, ApiRoute } from "#shared/protocol";
import type { Access, Auth } from "#auth";
import type { Transcripts } from "#claude";
import type { Hub } from "#hub";
import type { SessionRegistry } from "#sessions";
import type { SourceTable } from "#source";

export interface HttpDeps {
  auth: Auth;
  registry: SessionRegistry;
  transcripts: Transcripts;
  sources: SourceTable;
  hub: Hub;
  staticDir: string;
}

type ErrorBody = { error: ErrorCode };
type Parsed<R extends ApiRoute, K extends "req" | "query"> =
  ApiContract[R] extends Record<K, infer S extends z.ZodType> ? z.output<S> : undefined;

interface Ctx<R extends ApiRoute> {
  req: IncomingMessage;
  access: Access;
  /** `id` for routes with :id, raw; handlers parse it with parseSessionId. */
  params: { id?: string };
  /** Already parsed with the route's schema; a failure answered invalid_command before the handler ran. Never logged. */
  body: Parsed<R, "req">;
  query: Parsed<R, "query">;
}
type Reply<R extends ApiRoute> = { status: number; body: ApiRes<R> | ErrorBody; headers?: Record<string, string> };

/** A route must carry exactly the schemas its ApiContract entry names, so parsing cannot drift from the contract. */
type RouteSpec<R extends ApiRoute> = {
  access: "public" | "member";
  handle(ctx: Ctx<R>): Promise<Reply<R>>;
} & Pick<ApiContract[R], Extract<keyof ApiContract[R], "req" | "query">>;

/** Keyed by ApiContract: a route without a handler, or a handler with the wrong body type, fails the type check. */
type Routes = { [R in ApiRoute]: RouteSpec<R> };
declare const ROUTES: Routes;
// TODO ROUTES:
//   GET /api/me               public  { loggedIn: access.kind === "member", tailscaleLogin: access.login, deviceName: await auth.deviceName(req) }
//   POST /api/login           public  req: LoginBody   → auth.login(req, body.passphrase) → status, body, Set-Cookie
//   POST /api/logout          member  req: LogoutBody  → auth.logout(access.token, body.all ? "all" : "this") → clearing Set-Cookie
//   GET /api/logins           member  auth.loginLog(20)
//   GET /api/sessions         member  [...(await registry.list()).sessions]
//   GET /api/sessions/:id/chat member query: ChatQuery → session = registry.get(parseSessionId(id)) ?? pane_closed;
//                                     session.claudeSessionId ?? no_transcript → transcripts.page(cid, query.before ?? null, query.limit)
//   GET /api/sessions/:id/blocked member → source.readDialog(session) → blockedDialog(read.text)

/** The one way an error becomes an HTTP reply. */
export function errorReply(code: ErrorCode): { status: number; body: ErrorBody } {
  return { status: ERROR_INFO[code].http, body: { error: code } };
}

export function createHttpServer(deps: HttpDeps): Server {
  // TODO one pass per request, in this order:
  //   1. access = auth.check(req); forbidden → 403 on every path, static included. The bundle never loads on such a device,
//      so the 403 body itself is the spec 8.0 screen: a fixed HTML page "이 기기는 허용되지 않았습니다" when Accept
//      has text/html, else errorReply("forbidden"). No passphrase field ever reaches that device.
  //   2. API route (method + path matched against the ApiContract keys): POST and !auth.originAllowed(req) → 403;
  //      member route and access.kind !== "member" → 401; body (JSON, 512 KiB cap) and query through the route's schemas,
  //      a failure → invalid_command; else handle
  //   3. else static: a file under staticDir after normalize (no ".."), else index.html (SPA). Public: the bundle holds no data.
  //   headers: /api → Cache-Control: no-store; all → CSP default-src 'self'; style-src 'self' 'unsafe-inline' (xterm)
  //   upgrade "/ws": access.kind === "member" && auth.originAllowed(req), else write "HTTP/1.1 401|403" and destroy;
  //      new WebSocketServer({ noServer: true, maxPayload: 512 KiB }).handleUpgrade → hub.attach(ws, access.token)
  throw new Error("not implemented");
}
