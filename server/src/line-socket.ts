import { createConnection } from "node:net";

/**
 * `code` is the peer's error code, or one this client produces: "unreachable" (nothing was written) or "no_reply"
 * (the request was written, then the socket closed or the call timed out). Only an adapter interprets them.
 */
export type SocketReply = { ok: true; result: unknown } | { ok: false; code: string; message: string };

/** The wire format of one peer: how a request is written, and how a line is read as the reply to `id`. */
export interface LineCodec {
  request(id: string, method: string, params: object): string;
  /** The reply to `id`, or null for anything else (another id, an event, a broken line). */
  reply(line: string, id: string): SocketReply | null;
}

/**
 * One request per connection over a Unix socket, newline-delimited JSON both ways. herdr 0.9.5 answers one request
 * per connection and then ends it, dropping any pipelined request (measured), and herdr-core 0.1.19 is served the
 * same way, so every call opens its own connection. Concurrent connections are served in parallel (measured: 4
 * herdr pings in about 150 ms total).
 */
export interface LineSocket<M extends string> {
  /**
   * Sends one request and resolves with the reply carrying its id. Never rejects. `timeoutMs` overrides the socket's
   * default for calls the peer may hold (an input that waits for a quiet keyboard).
   * Connects lazily. After a connection failure, connects wait an exponential backoff (0.5 s doubling to 30 s);
   * calls inside that window resolve at once with "unreachable". The poll loop is what retries, so no reconnect
   * timer runs while no phone is connected. A good reply resets the backoff.
   */
  call(method: M, params: object, timeoutMs?: number): Promise<SocketReply>;
  close(): void;
}

const UNREACHABLE: SocketReply = { ok: false, code: "unreachable", message: "socket is not accepting connections" };

export function openLineSocket<M extends string>(path: string, defaultTimeoutMs: number, codec: LineCodec): LineSocket<M> {
  let nextId = 1;
  let downUntil = 0;
  let backoffMs = 500;
  let closed = false;
  const open = new Set<() => void>();

  function call(method: M, params: object, timeoutMs = defaultTimeoutMs): Promise<SocketReply> {
    if (closed || Date.now() < downUntil) return Promise.resolve(UNREACHABLE);
    const id = `sc:${nextId++}`;
    return new Promise((resolve) => {
      const sock = createConnection(path);
      let written = false;
      let rest = Buffer.alloc(0);
      const finish = (reply: SocketReply) => {
        clearTimeout(timer);
        open.delete(abort);
        sock.destroy();
        resolve(reply);
      };
      const lost = (message: string): SocketReply => (written ? { ok: false, code: "no_reply", message } : UNREACHABLE);
      const abort = () => finish(lost("socket closed by the client"));
      const timer = setTimeout(() => finish(lost(`no reply within ${timeoutMs} ms`)), timeoutMs);
      open.add(abort);

      sock.on("connect", () => {
        written = true;
        sock.write(`${codec.request(id, method, params)}\n`);
      });
      sock.on("data", (chunk) => {
        rest = Buffer.concat([rest, chunk]);
        for (let nl = rest.indexOf(0x0a); nl >= 0; nl = rest.indexOf(0x0a)) {
          const reply = codec.reply(rest.subarray(0, nl).toString("utf8"), id);
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
      sock.on("close", () => finish(lost("peer closed the connection without a reply")));
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

/** JSON.parse that never throws: an object, or null. */
export function parseObject(line: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
