import type { z } from "zod";
import type { SessionId } from "#shared/domain";
import type { ApiContract, ApiRes, ApiRoute } from "#shared/protocol";

/** Call arguments derived from the contract entry: `id` for :id routes, `body` from req, `query` from query. */
export type ApiArgs<R extends ApiRoute> = (R extends `${string}:id${string}` ? { id: SessionId } : unknown) &
  (ApiContract[R] extends { req: infer S extends z.ZodType } ? { body: z.input<S> } : unknown) &
  (ApiContract[R] extends { query: infer S extends z.ZodType } ? { query?: z.input<S> } : unknown);

/**
 * The only fetch wrapper. Returns null when the call failed, after it has already shown the failure: an ErrorCode
 * becomes a toast from ERROR_INFO, 401 moves to login with the path kept, 403 reloads the page so the server's 403
 * page shows, and a network failure is left to the connection banner. Callers never branch on error kinds. Login is the exception: its 401
 * and 429 bodies are LoginReply data, returned as such.
 */
export async function api<R extends ApiRoute>(route: R, args: ApiArgs<R>): Promise<ApiRes<R> | null> {
  throw new Error("not implemented");
}
