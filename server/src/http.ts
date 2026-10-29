import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, STATUS_CODES } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { extname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { WebSocketServer } from "ws";
import type { z } from "zod";
import { parseSessionId } from "#shared/domain";
import type { Session } from "#shared/domain";
import { ERROR_INFO } from "#shared/errors";
import type { ErrorCode } from "#shared/errors";
import { viewableType } from "#shared/files";
import { ChatQuery, FileQuery, LoginBody, LogoutBody } from "#shared/protocol";
import type { ApiContract, ApiRes, ApiRoute } from "#shared/protocol";
import type { Access, Auth } from "#auth";
import { blockedDialog } from "#claude";
import type { Transcripts } from "#claude";
import type { ConsoleConfig, FileCell, RuntimeFlags } from "#config";
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
  /** Read per response for the CSP connect-src hosts (publicOrigin, and devOrigin when set). */
  config: FileCell<ConsoleConfig | null>;
  flags: RuntimeFlags;
}

type ErrorBody = { error: ErrorCode };
type Parsed<R extends ApiRoute, K extends "req" | "query"> =
  ApiContract[R] extends Record<K, infer S extends z.ZodType> ? z.output<S> : undefined;

interface Ctx<R extends ApiRoute> {
  req: IncomingMessage;
  /** Gate 1 already passed: a forbidden request never reaches a route. */
  access: Exclude<Access, { kind: "forbidden" }>;
  /** `id` for routes with :id, percent-decoded but unparsed; handlers parse it with parseSessionId. */
  params: { id?: string };
  /** Already parsed with the route's schema; a failure answered invalid_command before the handler ran. Never logged. */
  body: Parsed<R, "req">;
  query: Parsed<R, "query">;
}
/** A file streamed as itself; the dispatcher sends it under FILE_CSP instead of as JSON. */
type ServedFile = { path: string; contentType: string; size: number };
type Reply<R extends ApiRoute> = { status: number; body: ApiRes<R> | ErrorBody; headers?: Record<string, string> } | { status: 200; file: ServedFile };

/** A route must carry exactly the schemas its ApiContract entry names, so parsing cannot drift from the contract. */
type RouteSpec<R extends ApiRoute> = {
  access: "public" | "member";
  handle(ctx: Ctx<R>): Promise<Reply<R>>;
} & Pick<ApiContract[R], Extract<keyof ApiContract[R], "req" | "query">>;

/** Keyed by ApiContract: a route without a handler, or a handler with the wrong body type, fails the type check. */
type Routes = { [R in ApiRoute]: RouteSpec<R> };

/** The one way an error becomes an HTTP reply. */
export function errorReply(code: ErrorCode): { status: number; body: ErrorBody } {
  return { status: ERROR_INFO[code].http, body: { error: code } };
}

function routes({ auth, registry, transcripts, sources }: HttpDeps): Routes {
  /** The `:id` segment to a listed session, polling first when the list is stale (curl with no phone connected). */
  async function sessionFor(raw: string | undefined): Promise<Session | ErrorCode> {
    const parsed = raw ? parseSessionId(raw) : null;
    if (!parsed) return "invalid_command";
    await registry.list();
    return registry.get(parsed.id) ?? "pane_closed";
  }

  return {
    "GET /api/me": {
      access: "public",
      async handle({ req, access }) {
        return { status: 200, body: { loggedIn: access.kind === "member", tailscaleLogin: access.login, deviceName: await auth.deviceName(req) } };
      },
    },
    "POST /api/login": {
      access: "public",
      req: LoginBody,
      async handle({ req, body }) {
        const r = await auth.login(req, body.passphrase);
        return { status: r.status, body: r.body, headers: r.setCookie ? { "Set-Cookie": r.setCookie } : undefined };
      },
    },
    "POST /api/logout": {
      access: "member",
      req: LogoutBody,
      async handle({ access, body }) {
        if (access.kind !== "member") return errorReply("unauthorized");
        return { status: 200, body: { ok: true }, headers: { "Set-Cookie": await auth.logout(access.token, body.all ? "all" : "this") } };
      },
    },
    "GET /api/logins": {
      access: "member",
      async handle() {
        return { status: 200, body: await auth.loginLog(20) };
      },
    },
    "GET /api/sessions": {
      access: "member",
      async handle() {
        return { status: 200, body: [...(await registry.list()).sessions] };
      },
    },
    "GET /api/sessions/:id/chat": {
      access: "member",
      query: ChatQuery,
      async handle({ params, query }) {
        const session = await sessionFor(params.id);
        if (typeof session === "string") return errorReply(session);
        if (!session.claudeSessionId) return errorReply("no_transcript");
        const page = await transcripts.page(session.claudeSessionId, query.before ?? null, query.limit);
        return page.ok ? { status: 200, body: page.events } : errorReply(page.error);
      },
    },
    "GET /api/sessions/:id/blocked": {
      access: "member",
      async handle({ params }) {
        const session = await sessionFor(params.id);
        if (typeof session === "string") return errorReply(session);
        const source = sources[session.source];
        if (!source) return errorReply("source_error");
        const read = await source.readDialog(session);
        return read.ok ? { status: 200, body: blockedDialog(read.text) } : errorReply(read.error);
      },
    },
    /** The transcript is the allowlist: only a file this session's Claude wrote, with a viewable extension, is served. */
    "GET /api/sessions/:id/file": {
      access: "member",
      query: FileQuery,
      async handle({ params, query }) {
        const session = await sessionFor(params.id);
        if (typeof session === "string") return errorReply(session);
        if (!session.claudeSessionId) return errorReply("no_transcript");
        const contentType = viewableType(query.path);
        if (!contentType || !isAbsolute(query.path) || !(await transcripts.wrote(session.claudeSessionId, query.path))) return errorReply("file_unavailable");
        const size = await stat(query.path).then(
          (s) => (s.isFile() ? s.size : null),
          () => null,
        );
        if (size === null) return errorReply("file_unavailable");
        return { status: 200, file: { path: query.path, contentType, size } };
      },
    },
  };
}

/** The route table after erasing per-route types; only the dispatcher sees it this way. */
type AnyRoute = {
  access: "public" | "member";
  req?: z.ZodType;
  query?: z.ZodType;
  handle(ctx: Ctx<ApiRoute>): Promise<{ status: number; body: unknown; headers?: Record<string, string> } | { status: 200; file: ServedFile }>;
};

/** Each contract key as a matcher. `:id` takes the raw segment, still percent-encoded, up to the next "/". */
function matchers(table: Routes) {
  return (Object.keys(table) as ApiRoute[]).map((key) => {
    const [method, pattern] = key.split(" ") as [string, string];
    const re = new RegExp(`^${pattern.replace(":id", "([^/]+)")}$`);
    return { method, re, route: table[key] as unknown as AnyRoute };
  });
}

const BODY_LIMIT = 512 * 1024;

/**
 * A written file runs with an opaque origin under `sandbox`: SameSite=Strict withholds the login cookie from its
 * requests and its Origin is "null", so a page Claude wrote cannot drive /api or /ws with the owner's login.
 * allow-scripts keeps interactive HTML working; nothing here grants same-origin.
 */
const FILE_CSP = "sandbox allow-scripts allow-popups allow-forms allow-modals";

const FORBIDDEN_PAGE = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>접근 거부</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:-apple-system,system-ui,sans-serif;background:#f6f6f4;color:#1d1d1b;padding:16px;box-sizing:border-box}
main{max-width:28rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .75rem}p{margin:0;line-height:1.5;color:#55554f}
@media (prefers-color-scheme:dark){body{background:#161615;color:#ececea}p{color:#a8a8a2}}</style></head>
<body><main><h1>이 기기는 허용되지 않았습니다.</h1>
<p>이 서비스는 소유자의 Tailscale 계정으로 접속한 기기에서만 열립니다.</p></main></body></html>
`;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export function createHttpServer(deps: HttpDeps): Server {
  const table = matchers(routes(deps));
  const staticRoot = resolve(deps.staticDir);
  const wss = new WebSocketServer({ noServer: true, maxPayload: BODY_LIMIT });

  /**
   * connect-src names the wss:// host besides 'self', because some Safari versions do not count wss: as 'self'.
   * frame-ancestors 'none' keeps the approval buttons out of other pages' frames.
   */
  function csp(): string {
    const hostOf = (origin: string | null | undefined) => {
      try {
        return origin ? new URL(origin).host : null;
      } catch {
        return null;
      }
    };
    const pub = hostOf(deps.config.read()?.publicOrigin);
    const dev = hostOf(deps.flags.devOrigin);
    const connect = ["'self'", pub && `wss://${pub}`, dev && `ws://${dev}`].filter(Boolean).join(" ");
    return `default-src 'self'; connect-src ${connect}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'`;
  }

  function baseHeaders(res: ServerResponse): void {
    res.setHeader("Content-Security-Policy", csp());
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
  }

  function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL, access: Ctx<ApiRoute>["access"]): Promise<void> {
    const reply = (r: Awaited<ReturnType<AnyRoute["handle"]>>) => {
      if (!("file" in r)) return json(res, r.status, r.body, r.headers);
      res.writeHead(200, { "Content-Type": r.file.contentType, "Content-Length": r.file.size, "Cache-Control": "no-store", "Content-Security-Policy": FILE_CSP });
      createReadStream(r.file.path)
        .on("error", () => res.destroy())
        .pipe(res);
    };
    let route: AnyRoute | null = null;
    let segment: string | undefined;
    for (const m of table) {
      const match = m.method === req.method ? m.re.exec(url.pathname) : null;
      if (!match) continue;
      route = m.route;
      segment = match[1];
      break;
    }
    if (!route) return reply(errorReply("invalid_command"));
    if (req.method === "POST" && !deps.auth.originAllowed(req)) return reply(errorReply("forbidden"));
    if (route.access === "member" && access.kind !== "member") return reply(errorReply("unauthorized"));

    let id: string | undefined;
    try {
      id = segment === undefined ? undefined : decodeURIComponent(segment);
    } catch {
      return reply(errorReply("invalid_command"));
    }
    let body: unknown;
    if (route.req) {
      const text = await readBody(req);
      let data: unknown;
      try {
        data = text === null ? undefined : JSON.parse(text);
      } catch {
        return reply(errorReply("invalid_command"));
      }
      const parsed = route.req.safeParse(data);
      if (!parsed.success) return reply(errorReply("invalid_command"));
      body = parsed.data;
    }
    let query: unknown;
    if (route.query) {
      const parsed = route.query.safeParse(Object.fromEntries(url.searchParams));
      if (!parsed.success) return reply(errorReply("invalid_command"));
      query = parsed.data;
    }
    reply(await route.handle({ req, access, params: { id }, body: body as never, query: query as never }));
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    let file: string | null = null;
    try {
      const candidate = join(staticRoot, normalize(`/${decodeURIComponent(url.pathname)}`));
      if (candidate.startsWith(staticRoot + sep) && (await stat(candidate)).isFile()) file = candidate;
    } catch {
      // Missing or undecodable: the SPA shell answers.
    }
    file ??= join(staticRoot, "index.html");
    const size = await stat(file).then(
      (s) => s.size,
      () => null,
    );
    if (size === null) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("웹 번들이 없습니다. 먼저 `pnpm start`로 웹을 빌드하세요.\n");
      return;
    }
    res.writeHead(200, { "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream", "Content-Length": size, "Cache-Control": "no-cache" });
    if (req.method === "HEAD") res.end();
    else createReadStream(file).pipe(res);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    baseHeaders(res);
    const url = new URL(req.url ?? "/", "http://localhost");
    const access = deps.auth.check(req);
    if (access.kind === "forbidden") {
      // Gate 1 covers static files too, so the bundle and its login form never reach such a device.
      if ((req.headers.accept ?? "").includes("text/html")) {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(FORBIDDEN_PAGE);
      } else json(res, 403, errorReply("forbidden").body);
      return;
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return api(req, res, url, access);
    return serveStatic(req, res, url);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      console.error(`request failed: ${req.method} ${new URL(req.url ?? "/", "http://localhost").pathname}: ${(e as Error).message}`);
      if (!res.headersSent) json(res, 500, errorReply("internal").body);
      else res.destroy();
    });
  });

  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    // Destroyed once the reply is flushed: a client that never closes its side must not hold the socket open.
    const refuse = (status: number) =>
      socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
    try {
      if (new URL(req.url ?? "/", "http://localhost").pathname !== "/ws") return refuse(404);
      const access = deps.auth.check(req);
      if (access.kind === "forbidden" || !deps.auth.originAllowed(req)) return refuse(403);
      if (access.kind !== "member") return refuse(401);
      wss.handleUpgrade(req, socket, head, (ws) => deps.hub.attach(ws, access.token));
    } catch (e) {
      console.error(`upgrade failed: ${(e as Error).message}`);
      refuse(500);
    }
  });
  server.on("close", () => wss.close());
  return server;
}

/** The body as text, or null when it is larger than BODY_LIMIT. */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= BODY_LIMIT) chunks.push(c);
    });
    req.on("end", () => resolveBody(size > BODY_LIMIT ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
