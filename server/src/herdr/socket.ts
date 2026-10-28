export type HerdrMethod =
  | "ping"
  | "session.snapshot"
  | "agent.read"
  | "agent.prompt"
  | "agent.send_keys"
  | "pane.send_keys"
  | "pane.send_text";

/**
 * `code` is herdr's error code, or one this client produces: "unreachable" (nothing was written) or "no_reply"
 * (the request was written, then the socket closed or the call timed out). Only the adapter interprets them.
 */
export type HerdrReply = { ok: true; result: unknown } | { ok: false; code: string; message: string };

/** NDJSON request/response over one herdr session's Unix socket (spec 4.2). */
export interface HerdrSocket {
  /**
   * Sends {id, method, params} and resolves with the reply carrying that id. Never rejects.
   * Connects lazily. After a connection failure, connects wait an exponential backoff (0.5 s doubling to 30 s);
   * calls inside that window resolve at once with "unreachable". The poll loop is what retries, so no reconnect
   * timer runs while no phone is connected.
   */
  call(method: HerdrMethod, params: object): Promise<HerdrReply>;
  close(): void;
}

export function openHerdrSocket(path: string, timeoutMs: number): HerdrSocket {
  // TODO
  //   state: sock: net.Socket | null; pending: Map<string, { resolve, timer }>; nextId; chunks; downUntil; backoffMs = 500
  //   data: split Buffer chunks at 0x0A before decoding (UTF-8 never contains 0x0A inside a character);
  //         JSON.parse each line; resolve pending.get(line.id); unknown ids are ignored
  //   close/error: resolve every pending with "no_reply" (they were written); sock = null; downUntil = now + backoffMs;
  //         backoffMs = min(2x, 30_000); the first good reply after a reconnect resets it to 500
  //   timeout: resolve "no_reply" and delete the pending entry; a late reply is then ignored
  //   ids: `sc:${nextId++}`
  throw new Error("not implemented");
}
