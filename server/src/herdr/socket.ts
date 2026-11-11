import { openLineSocket, parseObject } from "#line-socket";
import type { LineCodec, LineSocket, SocketReply } from "#line-socket";

export type HerdrMethod =
  | "ping"
  | "session.snapshot"
  | "agent.read"
  | "agent.prompt"
  | "agent.send_keys"
  | "pane.send_keys"
  | "pane.send_text";

export type HerdrReply = SocketReply;
export type HerdrSocket = LineSocket<HerdrMethod>;

/** herdr's wire format (spec 4.2): `{id, method, params}` in, `{id, result}` or `{id, error: {code, message}}` out. */
const HERDR_CODEC: LineCodec = {
  request: (id, method, params) => JSON.stringify({ id, method, params }),
  reply(line, id) {
    const msg = parseObject(line);
    if (!msg || msg.id !== id) return null;
    const { result, error } = msg as { result?: unknown; error?: { code?: unknown; message?: unknown } };
    if (error && typeof error.code === "string") return { ok: false, code: error.code, message: String(error.message ?? "") };
    return "result" in msg ? { ok: true, result } : null;
  },
};

/** NDJSON request/response over one herdr session's Unix socket. See LineSocket for the connection rules. */
export function openHerdrSocket(path: string, timeoutMs: number): HerdrSocket {
  return openLineSocket<HerdrMethod>(path, timeoutMs, HERDR_CODEC);
}
