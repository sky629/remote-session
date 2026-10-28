import type { z } from "zod";
import type { SessionId } from "#shared/domain";
import { ERROR_INFO } from "#shared/errors";
import type { ErrorCode } from "#shared/errors";
import type { ApiContract, ApiRes, ApiRoute } from "#shared/protocol";
import { dispatch, expireSession, openChat } from "./store.ts";

/** Call arguments derived from the contract entry: `id` for :id routes, `body` from req, `query` from query. */
export type ApiArgs<R extends ApiRoute> = (R extends `${string}:id${string}` ? { id: SessionId } : unknown) &
  (ApiContract[R] extends { req: infer S extends z.ZodType } ? { body: z.input<S> } : unknown) &
  (ApiContract[R] extends { query: infer S extends z.ZodType } ? { query?: z.input<S> } : unknown);

function errorCodeOf(body: unknown): ErrorCode | null {
  const code = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
  return typeof code === "string" && code in ERROR_INFO ? (code as ErrorCode) : null;
}

/**
 * The only fetch wrapper. Returns null when the call failed, after it has already shown the failure: an ErrorCode
 * becomes a toast from ERROR_INFO, 401 moves to login with the path kept, 403 reloads the page so the server's 403
 * page shows, and a network failure is left to the connection banner. Callers never branch on error kinds. Login is the exception: its 401
 * and 429 bodies are LoginReply data, returned as such.
 */
export async function api<R extends ApiRoute>(route: R, args: ApiArgs<R>): Promise<ApiRes<R> | null> {
  const [method, template] = route.split(" ") as [string, string];
  const { id, body, query } = args as { id?: SessionId; body?: unknown; query?: Record<string, unknown> };

  let url = id === undefined ? template : template.replace(":id", encodeURIComponent(id));
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined && value !== null) params.set(key, String(value));
  if (params.size > 0) url += `?${params}`;

  let res: Response;
  let data: unknown;
  try {
    res = await fetch(url, {
      method,
      cache: "no-store",
      headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    data = await res.json();
  } catch {
    // Offline, or a proxy answered without JSON while the server is down. The connection banner covers it.
    return null;
  }

  if (res.ok) return data as ApiRes<R>;
  if (route === "POST /api/login" && (res.status === 401 || res.status === 429)) return data as ApiRes<R>;
  if (res.status === 401) {
    expireSession();
    return null;
  }
  if (res.status === 403) {
    location.reload();
    return null;
  }
  const code = errorCodeOf(data);
  if (code) {
    dispatch({ type: "toast", text: ERROR_INFO[code].phone });
    if (code === "stale_cursor" && id !== undefined) {
      // The phone's `before` cursor no longer exists, so the thread cannot be extended. Start it over.
      dispatch({ type: "chat_reset", sessionId: id });
      void openChat(id);
    }
  }
  return null;
}
