import { openLineSocket, parseObject } from "#line-socket";
import type { LineCodec, LineSocket, SocketReply } from "#line-socket";

export type HcMethod = "server.status" | "terminal.list" | "terminal.read" | "terminal.send" | "terminal.keys";

export type HcReply = SocketReply;
export type HcSocket = LineSocket<HcMethod>;

/**
 * herdr-core's wire format (`hc schema`, 0.1.19): JSON-RPC 2.0, one message per line. An error carries a stable
 * `data.kind` ("blocked", "not_found", "invalid_params", ...), which is the code the adapter maps; the numeric
 * JSON-RPC code is the fallback for an error without one.
 */
const HC_CODEC: LineCodec = {
  request: (id, method, params) => JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  reply(line, id) {
    const msg = parseObject(line);
    if (!msg || msg.id !== id) return null;
    const { result, error } = msg as { result?: unknown; error?: { code?: unknown; message?: unknown; data?: { kind?: unknown } } };
    if (error) {
      const kind = error.data?.kind;
      return { ok: false, code: typeof kind === "string" ? kind : String(error.code ?? "error"), message: String(error.message ?? "") };
    }
    return "result" in msg ? { ok: true, result } : null;
  },
};

export function openHcSocket(path: string, timeoutMs: number): HcSocket {
  return openLineSocket<HcMethod>(path, timeoutMs, HC_CODEC);
}
