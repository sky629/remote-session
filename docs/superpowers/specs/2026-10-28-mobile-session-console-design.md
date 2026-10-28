# 모바일 세션 콘솔 설계

- 작성일: 2026-10-28
- 상태: 초안. 사용자 승인 전.
- 대상 독자: 이 문서만 보고 구현 계획을 세울 빌더.

## 1. 의도

사용자는 Mac에서 여러 Claude Code 세션을 herdr 안에서 동시에 돌린다. 밖에 있을 때 아이폰으로 그 세션 목록을 보고, 하나를 골라 대화를 이어가고, Claude가 멈춰서 기다리는 승인 요청에 답하고 싶어 한다.

cmux가 같은 기능을 iOS 앱으로 제공하지만 유료(Founders Edition)이다. 그래서 테일넷 안에서만 열리는 웹 앱을 직접 만든다.

## 2. 목표, 비목표, 실패 조건

### 목표

1. 아이폰 Safari에서 테일넷 주소로 접속하면 Mac의 Claude Code 세션 목록이 보인다. 각 세션의 상태(대기, 작업 중, 승인 필요, 완료, 확인 불가)가 실시간으로 바뀐다.
2. 세션을 열면 대화 화면이 기본으로 보인다. 지금까지의 대화를 읽을 수 있고, 새 메시지를 보내면 Mac의 Claude Code가 그 메시지를 받아 작업을 계속한다.
3. Claude가 승인을 기다리면 대화 화면에 승인 카드가 뜨고, 버튼 한 번으로 답할 수 있다.
4. 터미널 탭으로 전환하면 그 세션의 실제 터미널 화면을 폰 크기로 볼 수 있고, Esc, Enter, Ctrl+C, 화살표, 숫자 같은 키를 보낼 수 있다.
5. 홈 화면에 추가하면 앱처럼 열린다.

### 비목표 (1차에서 뺀다)

- 새 워크스페이스, 탭, 에이전트 만들기.
- 파일 탐색, diff 보기.
- 여러 사용자. 이 서비스는 소유자 한 명만 쓴다.
- Claude Code 외의 에이전트(Codex 등)에 맞춘 화면. 목록에는 나오되 대화 화면은 Claude 전용이다.
- Mac 밖에서 실행하기. 서버는 herdr 서버가 도는 그 Mac에서만 돈다.

### 실패 조건

- 테일넷 밖에서 접속할 수 있다.
- 폰에서 보낸 메시지가 Mac 화면의 Claude Code에 보이지 않거나, 두 번 들어간다.
- 승인 버튼이 다른 선택지에 눌린다.
- 서비스를 켜 둔 것만으로 Mac의 cmux나 herdr 동작이 바뀐다. (설정 변경, 포커스 이동, 터미널 크기 변경 모두 금지)

## 3. 제약

- cmux 설정은 바꾸지 않는다. cmux 소켓은 쓰지 않는다.
- herdr 서버를 재시작하거나 세션을 닫지 않는다. 읽기와 입력 전달만 한다.
- 인터넷에 포트를 열지 않는다. Tailscale Serve만 사용한다.
- 런타임은 이미 설치된 Node 24와 pnpm을 쓴다.

## 4. 확인한 환경 (2026-10-28, 모두 실제 실행으로 확인)

### 4.1 세션의 실제 소유자는 herdr이다

- 실행 중인 `claude --resume <id>` 프로세스 5개의 부모는 전부 `/opt/homebrew/opt/herdr/bin/herdr server`(pid 15724)이다. cmux는 herdr TUI 클라이언트를 띄우는 창일 뿐이다.
- herdr 0.9.5, Apache-2.0, Homebrew 설치. 세션은 두 개다. `default`(소켓 `~/.config/herdr/herdr.sock`, Claude 에이전트 6개, 워크스페이스 7개)와 `rocket`(소켓 `~/.config/herdr/sessions/rocket/herdr.sock`, 에이전트 없음).
- `herdr session list`로 세션과 소켓 경로를 얻는다.

### 4.2 herdr 소켓 API

- 전송: Unix 소켓, 줄 단위 JSON. 요청 `{"id","method","params"}`, 성공 `{"id","result":{"type",...}}`, 실패 `{"id","error":{"code","message"}}`. 인증 없음(로컬 소켓 권한이 보호 수단).
- 프로토콜 22. `ping`이 버전과 capabilities를 돌려준다.
- 쓰는 메서드와 파라미터는 9절 표에 있다. 전체 스키마는 `herdr api schema --json`으로 뽑는다(약 270KB).
- `events.subscribe`는 구독마다 `pane_id`가 필수다. 전체 세션에 대한 구독은 없다.
- `herdr terminal session observe <terminal_id> --cols N --rows N`은 읽기 전용 관찰자다. 입력, 크기 변경, 포커스를 가져가지 않는다. 출력은 줄 단위 JSON `{"type":"terminal.frame","seq","full","width","height","encoding":"base64","bytes"}`이고, bytes는 ANSI 이스케이프가 포함된 화면 바이트다. 첫 프레임은 전체 화면이고, 이후는 변경 시에만 온다. 3초 관찰 동안 작업 중인 에이전트는 프레임 1개를 보냈다.

### 4.3 에이전트 레코드

`agent.list`가 돌려주는 에이전트 하나의 필드(실제 값 예):

```json
{"agent":"claude","agent_status":"working","pane_id":"w11:p1","tab_id":"w11:t1","workspace_id":"w11",
 "terminal_id":"term_65eb9535b347f6","terminal_title":"◐ Lab 개념 제거 및 그룹볼트 설계",
 "terminal_title_stripped":"Lab 개념 제거 및 그룹볼트 설계",
 "cwd":"/Users/kang/.herdr/worktrees/rocket/remove-lab","foreground_cwd":"...",
 "agent_session":{"agent":"claude","kind":"id","source":"herdr:claude","value":"f2e47829-9e38-414c-811f-395503e66ba8"},
 "focused":true,"revision":8,"state_change_seq":223}
```

- `agent_status`는 `idle | working | blocked | done | unknown`이다. herdr가 화면을 인식해서 정한다. `blocked`는 승인 또는 질문 UI를 인식했다는 뜻이다.
- `agent_session.value`가 Claude Code 세션 id다. 이 값이 transcript 파일 이름과 같다.
- 워크스페이스 레코드(`workspace.list` 또는 `session.snapshot`)에 `label`(remove-lab 등), `worktree.checkout_path`, `agent_status`가 있다.

### 4.4 Claude Code transcript

- 경로: `~/.claude/projects/<프로젝트 슬러그>/<세션 id>.jsonl`. 슬러그는 작업 디렉터리 경로의 `/`와 `.`을 `-`로 바꾼 값이다. 사용자가 세션 중에 디렉터리를 옮길 수 있으므로, 슬러그를 계산하지 말고 `~/.claude/projects/*/<세션 id>.jsonl`을 찾는다. 실행 중인 5개 세션 모두 파일이 있었다.
- 줄 단위 JSON. 레코드 `type`이 매우 다양하다(`user`, `assistant`, `attachment`, `system`, `api-request-blob`, `ai-title`, `permission-mode`, `file-history-snapshot` 등 19종). 대화 화면은 `user`와 `assistant`만 쓴다. `isSidechain: true`는 서브에이전트 기록이므로 뺀다.
- `user` 레코드의 `message.content`는 사용자가 친 글이면 문자열이고, 도구 결과면 `[{type:"tool_result",...}]` 배열이다. `assistant` 레코드의 `message.content`는 `thinking | text | tool_use` 블록 배열이다.
- 공통 필드: `uuid`, `parentUuid`, `timestamp`, `sessionId`, `cwd`, `gitBranch`.
- `ai-title` 레코드의 `aiTitle`이 세션 제목이다. herdr의 `terminal_title_stripped`와 같은 값이다.
- 파일은 활성 세션 하나가 280MB에 이르기도 한다. 전체를 매번 파싱하지 말고, 처음에 끝에서부터 필요한 만큼만 읽고 이후에는 추가된 바이트만 읽는다.
- 승인 요청은 transcript에 기록되지 않는다. 승인 상태는 herdr의 `blocked`와 화면 텍스트로만 안다.

### 4.5 Tailscale

- 버전 1.104.2. 이 Mac의 MagicDNS 이름은 `macbookpro.tailfdccb7.ts.net`, 테일넷 `kkt629@gmail.com`. 아이폰 `iphone181`이 같은 테일넷에 있다.
- CLI 경로: `/Applications/Tailscale.app/Contents/MacOS/Tailscale`. `serve --bg`, `whois`, `cert`를 지원한다.
- `tailscale status --json`의 `CertDomains`가 비어 있다. 테일넷에 HTTPS 인증서가 아직 켜져 있지 않다는 뜻이다. **사용자가 Tailscale 관리 콘솔 DNS 탭에서 HTTPS Certificates를 켜야 한다.** 이것은 사용자가 해야 하는 유일한 외부 작업이다. 켜지 않으면 `tailscale serve`가 실패한다.
- Tailscale Serve를 거친 HTTP 요청에는 `Tailscale-User-Login`, `Tailscale-User-Name` 헤더가 붙는다. WebSocket 업그레이드도 Serve가 중계한다.

### 4.6 런타임

- Node v24.18.0. `process.features.typescript`가 `strip`이므로 백엔드 TypeScript를 빌드 없이 바로 실행할 수 있다.
- pnpm 설치됨. 저장소는 `/Users/kang/Documents/dev/remote-session`(이 문서를 쓰면서 `git init` 함).

## 5. 결정

### 5.1 사용자가 정한 것

- 폰에서 Claude와 주고받는 방식은 **C: 대화 화면이 기본, 터미널 탭을 추가**한다.
- 접속 경로는 Tailscale이다.

### 5.2 작성자(Claude)가 정한 것. 사용자가 바꿀 수 있다.

| 항목 | 결정 | 이유 |
| --- | --- | --- |
| 연결 지점 | herdr 소켓 API | Claude 프로세스를 소유한 층이다. 문서화된 API와 상태 인식이 있다. cmux 소켓은 외부 접근이 잠겨 있고 설정 변경이 필요하다. |
| 상태 갱신 방식 | `session.snapshot`을 클라이언트가 붙어 있는 동안만 1.5초 간격으로 폴링. 이벤트 구독은 쓰지 않는다. | 스냅샷은 12KB 수준이고 구독은 pane마다 따로 열어야 한다. 사용자 한 명의 폰 UI에는 폴링이 더 단순하고 충분하다. 지연이 문제로 확인되면 그때 pane별 `pane.agent_status_changed` 구독을 더한다. |
| 대화 데이터 | transcript 파일을 직접 읽는다 | Claude Code가 쓰는 원본이다. `agent.read`는 화면 텍스트라서 대화 구조가 없다. |
| 대화 갱신 | `fs.watch`로 파일 변경을 감지하고 추가된 바이트만 파싱 | 280MB 파일을 다시 읽지 않기 위해서다. |
| 입력 전달 | 메시지는 `agent.prompt`, 키는 `agent.send_keys` | herdr가 bracketed paste와 Enter를 한 번에 처리하고, `blocked` 상태면 `agent_blocked`로 거부해 준다. 터미널에 직접 쓰지 않는다. |
| 승인 응답 | `agent.read --source detection` 텍스트에서 번호 선택지를 뽑아 버튼으로 보여 주고, 누르면 그 숫자 키를 `agent.send_keys`로 보낸다. 선택지를 못 뽑으면 원문 텍스트와 범용 키(1, 2, 3, Enter, Esc, y, n)를 보여 준다. | Claude Code 승인 대화상자는 숫자 키로 선택된다. 인식 실패를 숨기지 않기 위해 원문을 항상 함께 보여 준다. |
| 터미널 탭 | `herdr terminal session observe`의 프레임을 WebSocket으로 그대로 전달하고, 폰에서 xterm.js가 그린다 | 읽기 전용 관찰자라 Mac 화면에 영향이 없다. 입력은 `agent.send_keys`로 보낸다. |
| 인증 | 서버는 127.0.0.1에만 바인드한다. 모든 요청에서 `Tailscale-User-Login` 헤더가 설정 파일의 소유자 로그인(`kkt629@gmail.com`)과 같은지 검사한다. | Serve를 거치지 않은 요청은 헤더가 없어서 거부된다. 로컬에서 직접 붙는 요청도 헤더가 없으므로 개발 시에는 환경 변수로 인증을 끈다. |
| 백엔드 | Node 24 + TypeScript(빌드 없음), `node:http` + `ws` | 라우트가 몇 개 없다. 프레임워크를 들이지 않는다. |
| 프런트엔드 | Vite + TypeScript + Preact, xterm.js | 작고 빠르다. PWA manifest와 최소 service worker(설치 가능하게만)를 넣는다. |
| 실행 | `pnpm start`로 전경 실행. launchd 등록은 1차에서 뺀다. 필요하면 후속으로 한다. | 먼저 손으로 켜고 끄며 검증한다. |
| 저장소 구조 | 한 패키지에 `server/`와 `web/` 디렉터리 | 모노레포 도구가 필요할 규모가 아니다. |

## 6. 데이터 모델

코드를 쓰기 전에 아래 모양을 먼저 타입으로 둔다. 조건문을 흩뿌리지 말고 이 구조에 담는다.

### 6.1 `Session` (목록의 한 줄, herdr 에이전트 pane 하나)

```ts
type HerdrSessionName = string;              // "default" | "rocket" | ...
type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

interface Session {
  id: string;                 // `${herdrSession}/${paneId}`  예: "default/w11:p1"
  herdrSession: HerdrSessionName;
  paneId: string;             // "w11:p1"
  terminalId: string;         // "term_65eb9535b347f6"
  workspaceLabel: string;     // "remove-lab"
  title: string | null;       // terminal_title_stripped
  cwd: string | null;
  agent: string | null;       // "claude" | "codex" | null
  status: AgentStatus;
  claudeSessionId: string | null;   // agent_session.value when agent === "claude"
  transcriptPath: string | null;    // 찾은 jsonl 경로
  stateChangeSeq: number;
}
```

에이전트가 없는 pane도 목록에 넣되 `agent: null`, `status: "unknown"`으로 표시한다. 목록 정렬은 `blocked` → `working` → `idle | done` → `unknown`, 같은 상태 안에서는 `stateChangeSeq` 내림차순이다.

### 6.2 상태 표시 (상태 기계가 아니라 표)

| `AgentStatus` | 폰 표시 | 색 역할 | 대화 화면의 입력창 |
| --- | --- | --- | --- |
| `blocked` | 승인 필요 | warning | 비활성. 승인 카드가 대신 뜬다. |
| `working` | 작업 중 | info | 활성. 보내면 큐에 들어간다고 안내한다. |
| `idle` | 대기 | neutral | 활성 |
| `done` | 완료 | success | 활성 |
| `unknown` | 확인 불가 | muted | 활성. 터미널 탭을 권한다. |

### 6.3 `ChatEvent` (transcript에서 뽑은 대화 한 조각)

```ts
type ChatEvent =
  | { kind: "user_text";  uuid: string; ts: string; text: string }
  | { kind: "assistant_text"; uuid: string; ts: string; text: string }
  | { kind: "tool_use";   uuid: string; ts: string; toolUseId: string; name: string; summary: string }
  | { kind: "tool_result"; uuid: string; ts: string; toolUseId: string; isError: boolean; preview: string };
```

- `thinking` 블록은 버린다.
- `tool_use.summary`는 입력에서 한 줄 요약을 만든다(예: `Bash: pnpm test`, `Edit: src/app.ts`). 요약 규칙은 도구 이름별 표로 둔다. 표에 없는 도구는 이름만 보여 준다.
- `tool_result.preview`는 앞 200자다.
- UI는 연속된 `tool_use`/`tool_result`를 하나의 접힌 묶음(`Bash ×3, Edit ×1`)으로 보여 준다.

### 6.4 `TerminalFrame`

herdr가 주는 레코드를 필드 그대로 전달한다. `{seq, full, width, height, bytes(base64)}`.

### 6.5 폰 → 서버 명령

```ts
type Command =
  | { type: "prompt"; sessionId: string; text: string }
  | { type: "keys";   sessionId: string; keys: string[] }     // herdr 키 이름: "enter", "esc", "ctrl+c", "up", "1"
  | { type: "watch_terminal"; sessionId: string; cols: number; rows: number }
  | { type: "unwatch_terminal"; sessionId: string };
```

## 7. 구성 요소

```
아이폰 Safari (PWA)
   │ HTTPS + WebSocket, Tailscale Serve가 중계, Tailscale-User-Login 헤더 부착
   ▼
server/  (Node 24, 127.0.0.1:PORT)
   ├─ auth        : 헤더 검사. 실패는 403.
   ├─ herdr       : 소켓 클라이언트. 세션별 소켓, 요청 id 매칭, 재연결.
   ├─ sessions    : 1.5초 폴링 → Session[] 계산 → 변경분만 WebSocket으로 push.
   ├─ transcript  : 세션 id로 jsonl 찾기, 끝에서부터 읽기, fs.watch 증분 파싱 → ChatEvent[].
   ├─ terminal    : `herdr terminal session observe` 자식 프로세스 1개/구독, 프레임 pass-through. 구독자가 없으면 종료.
   └─ commands    : prompt → agent.prompt, keys → agent.send_keys. 결과와 오류를 그대로 폰에 돌려준다.
   ▼
herdr server (default, rocket)  ──►  claude --resume … (×N)
```

### 7.1 서버 ↔ 폰 프로토콜

- `GET /api/sessions` → `Session[]`. 첫 화면용.
- `GET /api/sessions/:id/chat?before=<uuid>&limit=50` → `ChatEvent[]`. 위로 스크롤하면 더 읽는다.
- `GET /api/sessions/:id/blocked` → `{ text: string; options: {key: string; label: string}[] }`. `detection` 소스 텍스트와 파싱된 선택지.
- `WS /ws` → 서버가 `{type:"sessions", sessions}`, `{type:"chat", sessionId, events}`, `{type:"frame", sessionId, frame}`, `{type:"command_result", requestId, ok, error?}`를 보낸다. 폰은 `Command`에 `requestId`를 붙여 보낸다.
- 폰이 WebSocket으로 붙어 있는 동안만 herdr를 폴링한다. 아무도 없으면 폴링과 관찰자를 모두 멈춘다.

### 7.2 herdr 클라이언트 규칙

- 세션 목록은 `herdr session list --json`으로 시작할 때 읽고, 1분마다 다시 읽는다.
- 소켓이 끊기면 지수 백오프로 재연결한다. 끊긴 동안 그 herdr 세션의 `Session`들은 `status: "unknown"`에 `unreachable` 표시를 붙인다(Session에 `reachable: boolean` 필드를 추가해도 된다).
- `agent.prompt`는 `wait` 없이 보낸다. 상태 변화는 폴링이 가져온다.
- `agent_blocked` 오류는 폰에 "Claude가 승인을 기다리는 중이라 메시지를 보내지 않았습니다"로 보여 준다. 다시 보내지 않는다.

## 8. 화면

세 화면이다. 목업: https://claude.ai/artifact/Ear2krffWbpSF4VvE3RWEy

1. **세션 목록.** herdr 세션별로 묶는다. 한 줄에 워크스페이스 라벨, 상태 표시, 제목, 짧은 경로(`~/.herdr/worktrees/rocket/remove-lab`). `blocked`는 맨 위, 테두리 강조. 상단에 "N 작업 중" 요약.
2. **대화.** 헤더에 뒤로가기, 라벨, 상태 표시, 탭(대화 | 터미널). 본문은 사용자 말풍선(오른쪽), Claude 말풍선(왼쪽), 접힌 도구 묶음 칩. `blocked`면 하단에 승인 카드(원문 텍스트 + 선택지 버튼). 하단 입력창은 6.2 표를 따른다. 새 이벤트가 오면 맨 아래에 있을 때만 자동 스크롤한다.
3. **터미널.** xterm.js 뷰. 폰 가로폭에 맞는 cols와 rows를 계산해 `watch_terminal`로 보낸다. 하단에 키 버튼 줄(Esc, Enter, Ctrl+C, ↑, ↓, Tab, 1, 2, 3). 가로 모드에서는 cols를 다시 계산해 다시 구독한다.

공통: 다크/라이트 모두 지원. 폰 safe area를 지킨다. 연결이 끊기면 상단에 띠로 알리고 자동 재접속한다.

## 9. herdr API 매핑

| 용도 | 메서드 / 명령 | 파라미터 | 비고 |
| --- | --- | --- | --- |
| herdr 세션 목록 | `herdr session list --json` | | 소켓 경로를 얻는다 |
| 상태 폴링 | `session.snapshot` | `{}` | `workspaces`, `agents`, `panes`, `tabs`, `layouts` |
| 세션 상세 | `agent.get` | `{target}` | target은 pane_id 또는 에이전트 이름 |
| 승인 화면 텍스트 | `agent.read` | `{target, source:"detection", format:"text", strip_ansi:true}` | source enum은 API에서 `recent_unwrapped`(밑줄), CLI에서 `recent-unwrapped`(하이픈) |
| 메시지 보내기 | `agent.prompt` | `{target, text}` | `blocked`면 `agent_blocked` 오류 |
| 키 보내기 | `agent.send_keys` | `{target, keys:[...]}` | 키 이름 예: `enter`, `esc`, `ctrl+c`, `up`, `down`, `tab`, `1` |
| 터미널 화면 | `herdr terminal session observe <terminal_id> --cols N --rows N` | | 자식 프로세스. stdout이 줄 단위 JSON 프레임 |
| 살아있는지 | `ping` | `{}` | 재연결 판정 |

## 10. 보안

- 서버는 `127.0.0.1`에만 바인드한다. Tailscale Serve가 `https://macbookpro.tailfdccb7.ts.net`에서 이 포트로 프록시한다. `tailscale funnel`은 쓰지 않는다.
- 모든 HTTP 요청과 WebSocket 업그레이드에서 `Tailscale-User-Login`이 설정의 소유자와 같아야 한다. 아니면 403. 개발용 우회는 환경 변수 `CONSOLE_DEV_NO_AUTH=1`로만 켠다.
- 폰에서 들어온 텍스트는 herdr에 그대로 넘긴다. 셸을 거치지 않는다(`agent.prompt`는 소켓 JSON이다).
- transcript 파일은 읽기만 한다. `~/.claude/projects` 밖의 경로는 열지 않는다.
- 로그에 메시지 본문을 남기지 않는다.

## 11. 빌더에게 맡기는 것

- 패키지 배치, 빌드 스크립트, 테스트 러너 선택.
- `tool_use.summary` 요약 표의 구체 규칙.
- 번호 선택지 파싱 정규식과 그 테스트 입력. 파싱 실패 시 범용 키 UI로 떨어지는 동작은 유지한다.
- transcript 끝에서부터 읽는 방법(블록 단위 역방향 읽기 등)과 첫 로드 개수.
- xterm.js 설정(폰트 크기, 테마 토큰 연결), cols/rows 계산 방식.
- WebSocket 재접속 백오프 값.
- PWA manifest 아이콘.

## 12. 검증 기준 (완료 선언 전에 실제로 확인한다)

1. Mac에서 `pnpm start`를 켜고 `tailscale serve --bg <port>`를 등록한 뒤, 아이폰 Safari로 `https://macbookpro.tailfdccb7.ts.net`에 들어가면 목록에 현재 herdr 에이전트들이 실제 라벨과 상태로 보인다.
2. Mac에서 한 세션에 프롬프트를 쳐서 `working`으로 바꾸면 폰 목록이 2초 안에 바뀐다.
3. 폰에서 대기 중인 세션에 "현재 작업 디렉터리를 한 줄로 알려줘" 같은 메시지를 보내면, Mac의 Claude Code 화면에 그 메시지가 한 번 들어가고 응답이 폰 대화 화면에 나타난다.
4. Claude가 승인을 기다리는 상태를 만들고(예: 허용되지 않은 Bash 명령), 폰에 승인 카드가 뜨고, 버튼을 누르면 Mac 화면에서 그 선택지가 선택된다.
5. 터미널 탭이 Mac 화면과 같은 내용을 보여 주고, Mac 쪽 터미널 크기와 포커스는 바뀌지 않는다(`herdr pane layout`으로 전후 비교).
6. 테일넷에 없는 기기(예: 셀룰러만 켠 폰, Tailscale 끔)에서는 접속되지 않는다. `Tailscale-User-Login` 헤더 없이 `curl http://127.0.0.1:<port>/api/sessions`를 치면 403이다.
7. 서비스를 10분 켜 둔 뒤 `herdr status`와 cmux가 정상이고, `claude` 프로세스 수가 그대로다.

## 13. 열린 질문

빌더 점검 후에 채운다.
