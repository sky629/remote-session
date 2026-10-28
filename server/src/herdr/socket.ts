import { createConnection } from "node:net";

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

/**
 * NDJSON request/response over one herdr session's Unix socket (spec 4.2). herdr 0.9.5 answers one request per
 * connection and then ends it, dropping any pipelined request (measured), so every call opens its own connection.
 * Concurrent connections are served in parallel (measured: 4 pings in about 150 ms total).
 */
export interface HerdrSocket {
  /**
   * Sends {id, method, params} and resolves with the reply carrying that id. Never rejects.
   * Connects lazily. After a connection failure, connects wait an exponential backoff (0.5 s doubling to 30 s);
   * calls inside that window resolve at once with "unreachable". The poll loop is what retries, so no reconnect
   * timer runs while no phone is connected. A good reply resets the backoff.
   */
  call(method: HerdrMethod, params: object): Promise<HerdrReply>;
  close(): void;
}

const UNREACHABLE: HerdrReply = { ok: false, code: "unreachable", message: "herdr socket is not accepting connections" };

export function openHerdrSocket(path: string, timeoutMs: number): HerdrSocket {
  let nextId = 1;
  let downUntil = 0;
  let backoffMs = 500;
  let closed = false;
  const open = new Set<() => void>();

  function call(method: HerdrMethod, params: object): Promise<HerdrReply> {
    if (closed || Date.now() < downUntil) return Promise.resolve(UNREACHABLE);
    const id = `sc:${nextId++}`;
    return new Promise((resolve) => {
      const sock = createConnection(path);
      let written = false;
      let rest = Buffer.alloc(0);
      const finish = (reply: HerdrReply) => {
        clearTimeout(timer);
        open.delete(abort);
        sock.destroy();
        resolve(reply);
      };
      const lost = (message: string): HerdrReply => (written ? { ok: false, code: "no_reply", message } : UNREACHABLE);
      const abort = () => finish(lost("socket closed by the client"));
      const timer = setTimeout(() => finish(lost(`no reply within ${timeoutMs} ms`)), timeoutMs);
      open.add(abort);

      sock.on("connect", () => {
        written = true;
        sock.write(`${JSON.stringify({ id, method, params })}\n`);
      });
      sock.on("data", (chunk) => {
        rest = Buffer.concat([rest, chunk]);
        for (let nl = rest.indexOf(0x0a); nl >= 0; nl = rest.indexOf(0x0a)) {
          const reply = replyFor(rest.subarray(0, nl).toString("utf8"), id);
          rest = rest.subarray(nl + 1);
          if (reply) {
            backoffMs = 500;
            return finish(reply);
          }
        }
      });
      sock.on("error", () => {
        if (written) return;
        downUntil = Date.now() + backoffMs;
        backoffMs = Math.min(backoffMs * 2, 30_000);
      });
      sock.on("close", () => finish(lost("herdr closed the connection without a reply")));
    });
  }

  return {
    call,
    close() {
      closed = true;
      for (const abort of open) abort();
    },
  };
}

/** One line from herdr: the reply to `id`, or null for anything else (another id, an event, a broken line). */
function replyFor(line: string, id: string): HerdrReply | null {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null || (msg as { id?: unknown }).id !== id) return null;
  const { result, error } = msg as { result?: unknown; error?: { code?: unknown; message?: unknown } };
  if (error && typeof error.code === "string") return { ok: false, code: error.code, message: String(error.message ?? "") };
  return "result" in msg ? { ok: true, result } : null;
}
