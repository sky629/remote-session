// Throwaway stand-in for the real server, so the web app can be run and screenshotted alone.
//   node web/mock/server.mjs                     (port 7421)
//   CONSOLE_SERVER=127.0.0.1:7421 pnpm exec vite web
// Passphrase: test-passphrase. Five wrong attempts in a row answer 429 for 15 s.
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.MOCK_PORT ?? 7421);
const PASSPHRASE = "test-passphrase";
const COOKIE = "mock_session=1";

const row = (paneId, label, title, cwd, status, seq, claude) => ({
  id: `herdr:default/${paneId}`,
  source: "herdr",
  group: "default",
  paneId,
  terminalId: `term_${paneId.replace(":", "")}`,
  workspaceLabel: label,
  title,
  cwd,
  agent: claude ? "claude" : null,
  claudeSessionId: claude ?? null,
  stateChangeSeq: seq,
  transcriptPath: claude ? `/Users/kang/.claude/projects/x/${claude}.jsonl` : null,
  reachable: true,
  status,
});

let sessions = [
  row("w11:p1", "remove-lab", "Lab 개념 제거 및 그룹볼트 설계", "/Users/kang/.herdr/worktrees/rocket/remove-lab", "blocked", 223, "f2e47829-9e38-414c-811f-395503e66ba8"),
  row("wH:p1", "test", "cmux 원격 세션 웹 클라이언트", "/Users/kang/Documents/dev/remote-session", "working", 228, "d4c7d868-4577-4bd2-88c0-bdfb2baf949e"),
  row("w2:p1", "rocket", "코드 재초기화", "/Users/kang/Documents/searchdoc/rocket", "idle", 217, "173980c4-0d59-4741-aa45-320358812608"),
  row("wZ:p1", "llm-usage", "사용량 수집 모델링 RDB vs NoSQL", "/Users/kang/.herdr/worktrees/rocket/llm-usage", "idle", 190, "383fd19b-99ad-47a3-b3c0-38fba1f255c6"),
  row("w0:p1", "model-diversification", "에이전트 모델 분리", "/Users/kang/.herdr/worktrees/rocket/model-diversification", "idle", 192, "ee5fcc49-cc8f-46b4-97ad-593721f1957e"),
  row("wM:p1", "etc", "중복 폴더 생성 원인", "/Users/kang/Documents/dev/farland_tactics", "idle", 7, "c85999d5-2c72-44f9-a278-18cf9d1354e5"),
  row("w12:p1", "code-review", null, "/Users/kang/.herdr/worktrees/rocket/code-review", "unknown", 0, null),
];
const groups = [
  { source: "herdr", name: "default", reachable: true },
  { source: "herdr", name: "rocket", reachable: true },
];
const sessionsMessage = () => JSON.stringify({ type: "sessions", groups, sessions });

// A synthetic transcript, oldest first, one thread per Claude session.
const BASE_TIME = Date.now() - 3 * 60_000;
function makeThread(sessionId, rounds) {
  const events = [];
  let n = 0;
  const at = () => new Date(BASE_TIME - (rounds * 10 - n) * 20_000).toISOString();
  const push = (e) => {
    events.push({ uuid: `${sessionId}-${n}`, ts: at(), ...e });
    n++;
  };
  for (let r = 0; r < rounds; r++) {
    push({ kind: "user_text", text: r === rounds - 1 ? "Lab 개념을 제거하고 그룹볼트로 대체하는 설계안을 정리해줘" : `${r + 1}번째 요청입니다. 라우트와 스토어를 확인해 줘.` });
    for (const name of ["Grep", "Read", "Read"]) {
      const toolUseId = `tu-${sessionId}-${n}`;
      push({ kind: "tool_use", toolUseId, name, summary: `${name}: src/store/lab.ts` });
      push({ kind: "tool_result", toolUseId, isError: false, preview: "export const labStore = createStore({ …" });
    }
    const toolUseId = `tu-${sessionId}-${n}`;
    push({ kind: "tool_use", toolUseId, name: "Edit", summary: "Edit: src/routes/lab.tsx" });
    push({ kind: "tool_result", toolUseId, isError: r % 3 === 0, preview: r % 3 === 0 ? "Error: old_string not found" : "The file has been updated." });
    push({
      kind: "assistant_text",
      text:
        r === rounds - 1
          ? "rocket-ui에서 Lab을 참조하는 **파일 14개**를 찾았습니다. 라우트 3개와 스토어 2개를 그룹볼트 기준으로 바꾸는 순서를 정리했습니다.\n\n1. `labStore`를 `groupVaultStore`로 교체\n2. 라우트 3개를 새 스토어에 연결\n3. 타입 검사 실행\n\n```ts\nexport const groupVaultStore = createStore({ vaults: [] });\n```\n\n| 구분 | 개수 |\n| --- | --- |\n| 라우트 | 3 |\n| 스토어 | 2 |\n\n<script>alert('html은 해석되지 않습니다')</script>"
          : `${r + 1}번째 요청을 처리했습니다. \`src/store/lab.ts\`를 수정했습니다.`,
    });
  }
  return events;
}
const threads = new Map(sessions.filter((s) => s.claudeSessionId).map((s) => [s.id, makeThread(s.id, s.id.endsWith("w11:p1") ? 30 : 3)]));

const BLOCKED = {
  text: "Bash command\n\n  pnpm type-check\n  Run the type check of the web package\n\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and don't ask again for pnpm commands in /Users/kang/.herdr/worktrees/rocket/remove-lab\n  3. No, and tell Claude what to do differently (esc)",
  options: [
    { key: "1", label: "Yes" },
    { key: "2", label: "Yes, and don't ask again for pnpm commands" },
    { key: "3", label: "No, and tell Claude what to do differently" },
  ],
  dialogId: "d-1",
};

function ansiFrame() {
  const W = 155;
  const esc = (code, s) => `\x1b[${code}m${s}\x1b[0m`;
  const pad = (s, n) => s + " ".repeat(Math.max(0, n - [...s].length));
  const line = (s = "") => `${s}\r\n`;
  let out = "\x1b[2J\x1b[H";
  out += line(esc("2", "╭" + "─".repeat(W - 2) + "╮"));
  out += line(esc("2", "│") + " " + esc("38;5;111", "✻") + pad(" Claude Code · remove-lab", W - 4) + esc("2", "│"));
  out += line(esc("2", "╰" + "─".repeat(W - 2) + "╯"));
  out += line();
  out += line(esc("38;5;111", "●") + " Bash(pnpm type-check)");
  out += line("  " + esc("2", "⎿ ") + "Running…");
  out += line();
  out += line(esc("38;5;214", "Do you want to proceed?"));
  out += line(esc("38;5;111", "❯") + " 1. Yes");
  out += line("  2. Yes, and don't ask again for pnpm commands");
  out += line("  3. No, and tell Claude what to do differently");
  out += line();
  out += line(esc("38;5;114", "✔ 가나다라마바사 한글 폭 확인") + "  " + esc("38;5;203", "✘ error") + "  " + esc("1;4", "bold underline"));
  for (let i = 0; i < 38; i++) out += line(esc("2", `${String(i + 13).padStart(2, "0")} ` + "·".repeat(W - 3)));
  out += `\x1b[52;1H${esc("2", "─".repeat(W))}\r\n${esc("2", ">")} \x1b[7m \x1b[0m\r\n${esc("2", "  ? for shortcuts")}`;
  return Buffer.from(out).toString("base64");
}

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
};
const authed = (req) => (req.headers.cookie ?? "").includes(COOKIE);
const readBody = (req) =>
  new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data ? JSON.parse(data) : {}));
  });

let refuseUntil = 0;
let failures = 0;
let lockedUntil = 0;
const logins = [
  { ts: new Date(Date.now() - 3_600_000).toISOString(), ok: true, tailscaleLogin: "kkt629@gmail.com", device: "iPhone · Safari" },
  { ts: new Date(Date.now() - 7_200_000).toISOString(), ok: false, tailscaleLogin: "kkt629@gmail.com", device: "iPhone · Safari" },
];

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://mock");
  const route = `${req.method} ${url.pathname}`;
  if (route === "GET /api/__drop") {
    refuseUntil = Date.now() + Number(url.searchParams.get("ms") ?? 5000);
    wss.clients.forEach((ws) => ws.terminate());
    return json(res, 200, { ok: true });
  }
  if (route === "GET /api/me") {
    return json(res, 200, { loggedIn: authed(req), tailscaleLogin: "kkt629@gmail.com", deviceName: "iphone181" });
  }
  if (route === "POST /api/login") {
    const { passphrase } = await readBody(req);
    if (Date.now() < lockedUntil) return json(res, 429, { error: "rate_limited", retry_after: Math.ceil((lockedUntil - Date.now()) / 1000) });
    if (passphrase === PASSPHRASE) {
      failures = 0;
      logins.unshift({ ts: new Date().toISOString(), ok: true, tailscaleLogin: "kkt629@gmail.com", device: "Mac · Chrome" });
      return json(res, 200, { ok: true }, { "set-cookie": `${COOKIE}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000` });
    }
    failures++;
    logins.unshift({ ts: new Date().toISOString(), ok: false, tailscaleLogin: "kkt629@gmail.com", device: "Mac · Chrome" });
    if (failures >= 5) {
      failures = 0;
      lockedUntil = Date.now() + 15_000;
      return json(res, 429, { error: "rate_limited", retry_after: 15 });
    }
    return json(res, 401, { error: "wrong_passphrase", remaining: 5 - failures });
  }
  if (!authed(req)) return json(res, 401, { error: "unauthorized" });
  if (route === "POST /api/logout") return json(res, 200, { ok: true }, { "set-cookie": `${COOKIE}; Path=/; Max-Age=0` });
  if (route === "GET /api/logins") return json(res, 200, logins.slice(0, 20));
  if (route === "GET /api/sessions") return json(res, 200, sessions);
  const m = /^\/api\/sessions\/([^/]+)\/(chat|blocked)$/.exec(url.pathname);
  if (m && req.method === "GET") {
    const id = decodeURIComponent(m[1]);
    const session = sessions.find((s) => s.id === id);
    if (!session) return json(res, 410, { error: "pane_closed" });
    if (m[2] === "blocked") return json(res, 200, BLOCKED);
    const events = threads.get(id);
    if (!events) return json(res, 404, { error: "no_transcript" });
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const before = url.searchParams.get("before");
    const end = before ? events.findIndex((e) => e.uuid === before) : events.length;
    if (end < 0) return json(res, 410, { error: "stale_cursor" });
    return json(res, 200, events.slice(Math.max(0, end - limit), end));
  }
  json(res, 404, { error: "internal" });
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (new URL(req.url, "http://mock").pathname !== "/ws" || !authed(req) || Date.now() < refuseUntil) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
});

const clients = new Set();
const broadcast = (message) => clients.forEach((ws) => ws.readyState === 1 && ws.send(typeof message === "string" ? message : JSON.stringify(message)));
const setStatus = (id, status) => {
  sessions = sessions.map((s) => (s.id === id ? { ...s, status, stateChangeSeq: s.stateChangeSeq + 1 } : s));
  broadcast(sessionsMessage());
};
const pushChat = (sessionId, event) => {
  const events = threads.get(sessionId);
  const full = { uuid: `${sessionId}-live-${events.length}`, ts: new Date().toISOString(), ...event };
  events.push(full);
  broadcast({ type: "chat", sessionId, events: [full] });
};

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(sessionsMessage());
  ws.on("close", () => clients.delete(ws));
  ws.on("message", (data) => {
    const cmd = JSON.parse(String(data));
    ws.send(JSON.stringify({ type: "command_result", requestId: cmd.requestId, ok: true }));
    const id = cmd.sessionId;
    if (cmd.type === "watch_terminal") {
      ws.send(JSON.stringify({ type: "terminal_status", sessionId: id, state: "live" }));
      ws.send(JSON.stringify({ type: "frame", sessionId: id, frame: { seq: 1, full: true, width: 155, height: 54, bytes: ansiFrame() } }));
    } else if (cmd.type === "prompt") {
      setTimeout(() => pushChat(id, { kind: "user_text", text: cmd.text }), 1500);
      setTimeout(() => pushChat(id, { kind: "assistant_text", text: `받았습니다: ${cmd.text}` }), 3000);
    } else if (cmd.type === "keys" && cmd.guard) {
      setTimeout(() => setStatus(id, "working"), 600);
    }
  });
});

setInterval(() => {
  if (clients.size === 0) return;
  const id = sessions[1].id;
  pushChat(id, { kind: "assistant_text", text: `진행 상황 ${new Date().toLocaleTimeString("ko-KR")}: 파일을 읽는 중입니다.` });
}, 4000);

server.listen(PORT, "127.0.0.1", () => console.log(`mock server on http://127.0.0.1:${PORT}`));
