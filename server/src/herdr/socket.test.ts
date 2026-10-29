import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { openHerdrSocket } from "./socket.ts";

type Handler = (req: { id: string; method: string; params: unknown }, sock: Socket) => void;

const sockPath = () => join(mkdtempSync(join(tmpdir(), "sc-sock-")), "herdr.sock");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake herdr: one request per connection, like herdr 0.9.5. Counts connections. */
async function fakeHerdr(path: string, handler: Handler): Promise<{ server: Server; connections: () => number }> {
  let connections = 0;
  const server = createServer((sock) => {
    connections++;
    let buf = "";
    sock.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl >= 0) handler(JSON.parse(buf.slice(0, nl)), sock);
    });
    sock.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(path, r));
  return { server, connections: () => connections };
}
const reply = (sock: Socket, body: object) => sock.end(`${JSON.stringify(body)}\n`);

test("a reply is matched to its request by id, for results and for herdr errors", async () => {
  const path = sockPath();
  const { server } = await fakeHerdr(path, (req, sock) =>
    req.method === "ping"
      ? reply(sock, { id: req.id, result: { type: "pong", params: req.params } })
      : reply(sock, { id: req.id, error: { code: "agent_blocked", message: "blocked" } }),
  );
  const s = openHerdrSocket(path, 1000);
  assert.deepEqual(await s.call("ping", { x: 1 }), { ok: true, result: { type: "pong", params: { x: 1 } } });
  assert.deepEqual(await s.call("agent.prompt", { target: "w1:p1", text: "hi" }), { ok: false, code: "agent_blocked", message: "blocked" });
  server.close();
});

test("a reply split across chunks, even inside a multi-byte character, decodes whole", async () => {
  const path = sockPath();
  const text = "한글 제목 ✳ done";
  const { server } = await fakeHerdr(path, async (req, sock) => {
    const bytes = Buffer.from(`${JSON.stringify({ id: req.id, result: { text } })}\n`);
    const cut = bytes.indexOf(Buffer.from("글")) + 1; // inside the 3-byte sequence
    for (const part of [bytes.subarray(0, 5), bytes.subarray(5, cut), bytes.subarray(cut)]) {
      sock.write(part);
      await sleep(15);
    }
    sock.end();
  });
  assert.deepEqual(await openHerdrSocket(path, 1000).call("ping", {}), { ok: true, result: { text } });
  server.close();
});

test("lines with another id are ignored until the matching reply arrives", async () => {
  const path = sockPath();
  const { server } = await fakeHerdr(path, (req, sock) => {
    sock.write(`${JSON.stringify({ id: "other", result: { type: "stray" } })}\nnot json\n`);
    reply(sock, { id: req.id, result: { type: "pong" } });
  });
  assert.deepEqual(await openHerdrSocket(path, 1000).call("ping", {}), { ok: true, result: { type: "pong" } });
  server.close();
});

test("a written request without a reply is no_reply, on timeout and on close", async () => {
  const path = sockPath();
  const { server } = await fakeHerdr(path, (req, sock) => {
    if (req.method === "agent.prompt") sock.end();
  });
  const s = openHerdrSocket(path, 100);
  const timedOut = await s.call("ping", {});
  assert.equal(!timedOut.ok && timedOut.code, "no_reply");
  const closed = await s.call("agent.prompt", { target: "w1:p1", text: "x" });
  assert.equal(!closed.ok && closed.code, "no_reply");
  server.close();
});

test("a socket nobody listens on is unreachable, and close() ends calls in flight", async () => {
  const missing = await openHerdrSocket(sockPath(), 1000).call("ping", {});
  assert.equal(!missing.ok && missing.code, "unreachable");

  const path = sockPath();
  const { server } = await fakeHerdr(path, () => {});
  const s = openHerdrSocket(path, 5000);
  const pending = s.call("session.snapshot", {});
  await sleep(50);
  s.close();
  const r = await pending;
  assert.equal(!r.ok && r.code, "no_reply");
  const after = await s.call("ping", {});
  assert.equal(!after.ok && after.code, "unreachable", "a closed client never connects again");
  server.close();
});

test("after a failed connect, calls inside the backoff window never connect; the window doubles, a good reply resets it", async () => {
  // Only Date is mocked: the window is measured on the clock, while socket I/O stays real.
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    const path = sockPath();
    const s = openHerdrSocket(path, 1000);
    const code = async () => {
      const r = await s.call("ping", {});
      return r.ok ? "ok" : r.code;
    };
    assert.equal(await code(), "unreachable", "first failure opens a 0.5 s window");
    mock.timers.tick(501);
    assert.equal(await code(), "unreachable", "second failure opens a 1 s window");
    const { server, connections } = await fakeHerdr(path, (req, sock) => reply(sock, { id: req.id, result: {} }));
    mock.timers.tick(999);
    assert.equal(await code(), "unreachable", "still inside the 1 s window");
    assert.equal(connections(), 0, "no connection was attempted inside the window");
    mock.timers.tick(2);
    assert.equal(await code(), "ok");
    assert.equal(connections(), 1);
    await new Promise((r) => server.close(r));
    assert.equal(await code(), "unreachable");
    const again = await fakeHerdr(path, (req, sock) => reply(sock, { id: req.id, result: {} }));
    mock.timers.tick(501);
    assert.equal(await code(), "ok", "the good reply reset the window to 0.5 s, not 2 s");
    again.server.close();
  } finally {
    mock.timers.reset();
  }
});
