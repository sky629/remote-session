# 모바일 세션 콘솔 설계

- 작성일: 2026-10-28
- 상태: 2026-10-28 사용자 승인("진행하자"). 승인 시점의 미결 두 건(cmux 범위, 시험 세션)은 작성자 기본값으로 진행하며 5.1절에 적었다.
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
6. 첫 화면은 로그인이다. 암호를 모르면 테일넷 안에 있어도 세션 목록을 볼 수 없다. 한 번 로그인하면 정한 기간 동안 유지된다.

### 비목표 (1차에서 뺀다)

- 새 워크스페이스, 탭, 에이전트 만들기.
- 파일 탐색, diff 보기.
- 여러 사용자. 이 서비스는 소유자 한 명만 쓴다.
- Claude Code 외의 에이전트(Codex 등)에 맞춘 화면. 목록에는 나오되 대화 화면은 Claude 전용이다.
- Mac 밖에서 실행하기. 서버는 herdr 서버가 도는 그 Mac에서만 돈다.

### 실패 조건

- 테일넷 밖에서 접속할 수 있다.
- 로그인하지 않은 상태에서 세션 목록, 대화, 터미널 중 하나라도 보이거나, API가 데이터를 돌려준다.
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
- `herdr terminal session observe <terminal_id> --cols N --rows N`은 읽기 전용 관찰자다. 입력, 크기 변경, 포커스를 가져가지 않는다. 출력은 줄 단위 JSON `{"type":"terminal.frame","seq","full","width","height","encoding":"ansi","bytes"}`이고, `bytes`는 ANSI 이스케이프가 포함된 화면 바이트를 base64로 적은 문자열이다(`encoding` 값은 `"ansi"`로 실측됨). 스트림이 끝나면 `{"type":"terminal.closed"}` 레코드가 온다. 첫 프레임은 전체 화면이고, 이후는 변경 시에만 온다. 3초 관찰 동안 작업 중인 에이전트는 프레임 1개를 보냈다.
- **`--cols`/`--rows`는 PTY 크기를 바꾸지 않고 화면을 잘라서 보낸다(확인함).** pane이 155×54인 터미널을 `--cols 60 --rows 24`로 관찰하면 프레임 메타는 `width:60,height:24`이고, 내용은 왼쪽 위 60칸×24줄만 온다(줄은 60칸에서 잘리고, 51행에 있는 프롬프트는 보이지 않는다). `--cols 155 --rows 54`로 관찰하면 전체 화면이 그대로 온다. 관찰 전후로 모든 pane 크기는 155×54로 변하지 않았다. 따라서 **관찰자는 항상 pane의 실제 크기(`layouts[].panes[].rect`)로 연다.**

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
- 줄 단위 JSON. 레코드 `type`이 매우 다양하다(`user`, `assistant`, `attachment`, `system`, `api-request-blob`, `ai-title`, `permission-mode`, `file-history-snapshot` 등 19종). 대화 화면은 `user`와 `assistant`만 쓴다. `isSidechain: true`는 서브에이전트 기록이므로 뺀다. `isMeta: true`인 user 레코드는 스킬 본문 주입 같은 자동 삽입이므로 뺀다(실측 88개). `<command-name>…</command-name>`으로 시작하는 user 문자열은 슬래시 명령이므로 `/명령` 형태로 짧게 보여 주고, `<local-command-`, `<task-notification>`, `<system-reminder>`로 시작하는 문자열은 뺀다. 긴 붙여넣기는 `<pasted_content id="…">…</pasted_content>`로 감싸여 기록된다.
- 한 assistant 메시지는 블록마다 별도 레코드로 기록될 수 있다(`message.id`는 같고 `uuid`는 다르다). 작업 중에 받은 메시지는 `queue-operation` 레코드로 먼저 기록되고, 꺼낼 때 `user` 레코드가 쓰인다.
- 설계서 전체 줄 가운데 user/assistant 줄은 약 18%이고, `"type":"user"` 또는 `"type":"assistant"` 문자열 포함 여부로 JSON 파싱 전에 거를 수 있다(실측: 10,691줄 중 1,918줄, 누락 없음).
- `user` 레코드의 `message.content`는 사용자가 친 글이면 문자열이고, 도구 결과면 `[{type:"tool_result",...}]` 배열이다. `assistant` 레코드의 `message.content`는 `thinking | text | tool_use` 블록 배열이다.
- 공통 필드: `uuid`, `parentUuid`, `timestamp`, `sessionId`, `cwd`, `gitBranch`.
- `ai-title` 레코드의 `aiTitle`이 세션 제목이다. herdr의 `terminal_title_stripped`와 같은 값이다.
- 파일은 활성 세션 하나가 280MB에 이르기도 한다. 전체를 매번 파싱하지 말고, 처음에 끝에서부터 필요한 만큼만 읽고 이후에는 추가된 바이트만 읽는다.
- 승인 요청은 transcript에 기록되지 않는다. 승인 상태는 herdr의 `blocked`와 화면 텍스트로만 안다.

### 4.5 Tailscale

- 버전 1.104.2. 이 Mac의 MagicDNS 이름은 `macbookpro.tailfdccb7.ts.net`, 테일넷 `kkt629@gmail.com`. 아이폰 `iphone181`이 같은 테일넷에 있다.
- CLI 경로: `/Applications/Tailscale.app/Contents/MacOS/Tailscale`. `serve --bg`, `whois`, `cert`를 지원한다.
- `tailscale status --json`의 `CertDomains`가 비어 있다. 테일넷에 HTTPS 인증서가 아직 켜져 있지 않을 가능성이 높다(추정). **사용자가 Tailscale 관리 콘솔의 DNS 페이지에서 HTTPS Certificates 항목의 "Enable HTTPS"를 켜야 한다.** MagicDNS는 이미 켜져 있다. 이것은 사용자가 해야 하는 유일한 외부 작업이다. 빌더는 `tailscale serve --bg <port>`가 성공하는지로 확인한다. 실패하면 그 오류 메시지를 사용자에게 그대로 전달한다.
- Tailscale Serve를 거친 HTTP 요청에는 `Tailscale-User-Login`, `Tailscale-User-Name` 헤더가 붙는다. WebSocket 업그레이드도 Serve가 중계한다.

### 4.6 런타임

- Node v24.18.0. `process.features.typescript`가 `strip`이므로 백엔드 TypeScript를 빌드 없이 바로 실행할 수 있다.
- pnpm 설치됨. 저장소는 `/Users/kang/Documents/dev/remote-session`(이 문서를 쓰면서 `git init` 함).

## 5. 결정

### 5.1 사용자가 정한 것

- 폰에서 Claude와 주고받는 방식은 **C: 대화 화면이 기본, 터미널 탭을 추가**한다.
- 접속 경로는 Tailscale이다.
- **첫 화면에 로그인이 있어야 한다.** 테일넷에 들어온 기기라도 암호 없이는 아무것도 볼 수 없다.
- 설계서 전체를 승인했다.

### 5.1.1 승인 시점에 기본값으로 진행한 것 (사용자가 바꿀 수 있다)

- **cmux 세션 범위는 C다.** 1차는 herdr 세션만 보여 준다. 다만 `Session`에 `source` 필드(`"herdr"` 또는 `"cmux"`)를 지금 넣어서, 2차에 cmux 어댑터를 붙일 때 UI를 바꾸지 않게 한다. 지금 Mac의 Claude Code 세션은 전부 herdr 안에 있고 cmux가 자체 등록한 Claude 세션은 없다.
- **검증용 시험 세션을 만든다.** 12.1절 절차대로 `console-test` 워크스페이스를 만들어 쓰고 지운다.

### 5.2 작성자(Claude)가 정한 것. 사용자가 바꿀 수 있다.

| 항목 | 결정 | 이유 |
| --- | --- | --- |
| 연결 지점 | herdr 소켓 API | Claude 프로세스를 소유한 층이다. 문서화된 API와 상태 인식이 있다. cmux 소켓은 외부 접근이 잠겨 있고 설정 변경이 필요하다. |
| 상태 갱신 방식 | `session.snapshot`을 클라이언트가 붙어 있는 동안만 1.5초 간격으로 폴링. 이벤트 구독은 쓰지 않는다. | 스냅샷은 12KB 수준이고 구독은 pane마다 따로 열어야 한다. 사용자 한 명의 폰 UI에는 폴링이 더 단순하고 충분하다. 지연이 문제로 확인되면 그때 pane별 `pane.agent_status_changed` 구독을 더한다. |
| 대화 데이터 | transcript 파일을 직접 읽는다 | Claude Code가 쓰는 원본이다. `agent.read`는 화면 텍스트라서 대화 구조가 없다. |
| 대화 갱신 | `fs.watch`로 파일 변경을 감지하고 추가된 바이트만 파싱 | 280MB 파일을 다시 읽지 않기 위해서다. |
| 입력 전달 | 메시지는 `agent.prompt`, 키는 `agent.send_keys`. 예외는 터미널 탭의 글자 입력란 하나뿐이고, 그것만 `pane.send_text`(Enter를 붙이지 않는 저수준 쓰기)를 쓴다. | herdr가 bracketed paste와 Enter를 한 번에 처리하고, `blocked` 상태면 `agent_blocked`로 거부해 준다. 대화 화면은 절대 터미널에 직접 쓰지 않는다. 터미널 탭은 정의상 날것의 화면이므로, 승인 대화상자의 "다르게 하라고 알려주기" 같은 글자 입력을 여기서만 허용한다. |
| 승인 응답 | `agent.read --source detection` 텍스트에서 번호 선택지를 뽑아 버튼으로 보여 주고, 누르면 그 숫자 키를 `agent.send_keys`로 보낸다. 선택지를 못 뽑으면 원문 텍스트와 범용 키(1, 2, 3, Enter, Esc, y, n)를 보여 준다. | Claude Code 승인 대화상자는 숫자 키로 선택된다. 인식 실패를 숨기지 않기 위해 원문을 항상 함께 보여 준다. |
| 터미널 탭 | `herdr terminal session observe`를 **pane의 실제 크기**로 열고, 프레임을 WebSocket으로 그대로 전달한다. 폰에서 xterm.js를 같은 크기(예: 155×54)로 만들고, 기본은 폰 폭에 맞춰 축소(CSS transform scale)해서 전체를 보여 주며, 토글로 원래 크기 + 가로 스크롤로 바꾼다. | 관찰자는 요청한 크기로 화면을 자르기만 하므로(4.2절), 폰 크기로 열면 프롬프트 줄이 잘려 나간다. 읽기 전용 관찰자라 Mac 화면에 영향이 없다. 키는 `agent.send_keys`, 글자는 입력란에서 `pane.send_text`로 보낸다. |
| 인증 1차 관문 | 서버는 127.0.0.1에만 바인드한다. 모든 요청에서 `Tailscale-User-Login` 헤더가 설정 파일의 소유자 로그인(`kkt629@gmail.com`)과 같은지 검사한다. 아니면 403. | Serve를 거치지 않은 요청은 헤더가 없어서 거부된다. 로컬에서 직접 붙는 요청도 헤더가 없으므로 개발 시에는 환경 변수로 이 관문만 끈다. |
| 인증 2차 관문 (로그인) | 암호(passphrase) 하나를 서버 설정에 scrypt 해시로 저장한다. 로그인 화면에서 암호를 맞히면 서버가 무작위 세션 토큰을 만들어 `HttpOnly; Secure; SameSite=Strict` 쿠키로 준다. 유효 기간은 30일이고, 서버가 토큰 목록을 파일에 저장해서 재시작해도 유지된다. 로그아웃은 그 토큰을 지운다. 실패는 IP당 분당 5회로 제한한다. | 사용자 요구다. 폰을 잃어버리거나 테일넷에 다른 기기가 들어와도 암호 없이는 세션을 볼 수 없다. WebAuthn(Face ID)은 더 좋지만 구현량이 커서 후속으로 미룬다. |
| 암호 설정 | `pnpm passphrase`가 터미널에서 암호를 두 번 받아(8자 이상, 12자 이상 권장) 해시를 설정 파일(`~/.config/session-console/config.json`, 권한 600)에 쓴다. 평문 암호는 어디에도 저장하지 않는다. 다시 실행해 암호를 바꾸면 모든 로그인 토큰이 무효가 된다. scrypt는 `maxmem` 64MiB로 호출한다(Node 24 기본값 32MiB에서는 N=2^15, r=8이 `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`로 실패함, 실측). | 서버를 처음 켜기 전에 한 번만 하면 된다. 스크립트 이름을 `setup`으로 두지 않는 이유는 `pnpm setup`이 pnpm 11.5.2의 내장 명령이라 스크립트가 실행되지 않기 때문이다(실측). 폰에서 암호를 바꾸는 화면은 만들지 않는다. |
| 토큰 폐기 | `pnpm revoke-all`이 저장된 토큰을 모두 지우고, 토큰마다 저장한 User-Agent와 로그인 시각을 출력한다. 서버는 로그인 성공과 실패를 시각, Tailscale 계정, 기기 종류와 함께 기록한다(암호는 기록하지 않는다). | 폰을 잃어버렸을 때 Mac에서 바로 끊는다. |
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
  id: string;                 // `${source}:${group}/${paneId}`  예: "herdr:default/w11:p1"
  source: "herdr" | "cmux";   // 1차는 "herdr"만 만든다. 2차 cmux 어댑터용 자리.
  group: string;              // 소스 안의 묶음 이름. herdr에서는 herdr 세션 이름("default", "rocket"). (처음 이름 herdrSession에서 바꿈)
  reachable: boolean;         // 그 그룹의 소켓이 살아 있는가. false이면 status는 반드시 "unknown"이다(타입으로 강제).
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

### 6.5 `AuthSession` (로그인 상태)

```ts
interface AuthSession {
  tokenHash: string;     // 쿠키 토큰의 sha256. 원문 토큰은 쿠키에만 있다.
  createdAt: string;
  expiresAt: string;     // createdAt + 30일
  userAgent: string;     // 어느 기기인지 사람이 알아보기 위한 표시용
}
```

서버는 `AuthSession[]`을 설정 디렉터리의 파일에 저장한다. 만료된 항목은 읽을 때 지운다.

### 6.6 폰 → 서버 명령

```ts
type Command =
  | { type: "prompt"; sessionId: string; text: string }
  | { type: "keys";   sessionId: string; keys: string[]; guard?: { dialogId: string } }  // herdr 키 이름: "enter", "esc", "ctrl+c", "up", "1". guard가 있으면 서버가 보내기 직전에 승인 화면을 다시 읽어 dialogId가 다르면 stale_dialog로 거부한다.
  | { type: "raw_text"; sessionId: string; text: string }     // 터미널 탭 입력란 전용. pane.send_text. Enter는 붙이지 않는다.
  | { type: "watch_terminal"; sessionId: string }             // 크기는 서버가 pane rect에서 정한다
  | { type: "unwatch_terminal"; sessionId: string }
  | { type: "watch_chat"; sessionId: string }                 // 이 세션의 transcript를 따라가 chat 메시지를 밀어 달라는 뜻. 서버가 어느 파일을 감시할지 알 유일한 방법이다.
  | { type: "unwatch_chat"; sessionId: string };
```

모든 명령에는 폰이 만든 `requestId`가 붙는다. 서버는 같은 `requestId`를 2분 동안 기억해서, 재전송된 명령에는 저장된 결과를 돌려주고 herdr에는 다시 보내지 않는다. 메시지가 두 번 들어가는 실패 조건을 구조로 막기 위해서다.

herdr 키 이름 문법(CLI 레퍼런스 기준): 인쇄 가능한 글자 하나(`a`), 특수 키(`enter`, `tab`, `esc`, `backspace`, `left`, `right`, `up`, `down`), 조합(`ctrl+c`, `alt+x`, `shift+tab`), 기능 키(`f1`), 이름 붙은 문장 부호(`minus`, `plus`, `backtick`). 숫자 키 `1`이 글자 하나로 통과하는지는 빌더가 시험 세션에서 확인한다.

## 7. 구성 요소

```
아이폰 Safari (PWA)
   │ HTTPS + WebSocket, Tailscale Serve가 중계, Tailscale-User-Login 헤더 부착
   ▼
server/  (Node 24, 127.0.0.1:PORT)
   ├─ auth        : 1차 Tailscale 헤더 검사(실패 403) → 2차 로그인 쿠키 검사(실패 401, 로그인 화면으로).
   │                `/api/login`, 정적 파일, manifest만 2차 관문 없이 통과한다.
   ├─ herdr       : 소켓 클라이언트. 세션별 소켓, 요청 id 매칭, 재연결.
   ├─ sessions    : 1.5초 폴링 → Session[] 계산 → 변경분만 WebSocket으로 push.
   ├─ transcript  : 세션 id로 jsonl 찾기, 끝에서부터 읽기, fs.watch 증분 파싱 → ChatEvent[].
   ├─ terminal    : `herdr terminal session observe <terminal_id> --cols <rect.width> --rows <rect.height>` 자식 프로세스 1개/구독, 프레임 pass-through. 구독자가 없으면 종료. `terminal.closed` 레코드가 오면 폰에 알리고 재시작한다.
   └─ commands    : prompt → agent.prompt, keys → agent.send_keys, raw_text → pane.send_text. 결과와 오류를 그대로 폰에 돌려준다.
   ▼
herdr server (default, rocket)  ──►  claude --resume … (×N)
```

### 7.1 서버 ↔ 폰 프로토콜

- `POST /api/login` `{passphrase}` → 200이면 쿠키 설정, 401이면 `{error:"wrong_passphrase"}`, 429면 잠시 후 다시. 2차 관문 없이 열린 유일한 API다.
- `POST /api/logout` → 쿠키의 토큰을 지운다.
- `GET /api/me` → `{loggedIn: boolean, tailscaleLogin: string, deviceName: string | null}`. 앱이 켜질 때 로그인 화면을 보일지 정한다. `deviceName`은 서버가 `tailscale whois`로 알아낸 기기 이름이고 못 알아내면 null이다.
- `GET /api/logins` → 최근 로그인 시도 20건 `{ts, ok, tailscaleLogin, device}[]`. 8.0절 메뉴 "로그인 기록"용.
- `GET /api/sessions` → `Session[]`. 12절의 curl 검증과 첫 화면용. 폰은 보통 WebSocket의 `sessions` 메시지로 받는다.
- `GET /api/sessions/:id/chat?before=<uuid>&limit=50` → `ChatEvent[]`. 위로 스크롤하면 더 읽는다.
- `GET /api/sessions/:id/blocked` → `{ text: string; options: {key: string; label: string}[] }`. `detection` 소스 텍스트와 파싱된 선택지.
- `WS /ws` → 서버가 다음 메시지를 보낸다. 폰은 `Command`에 `requestId`를 붙여 보낸다.
  - `{type:"sessions", groups:[{source, name, reachable}], sessions}`: 항상 전체 목록이고 바뀌었을 때만 보낸다. 폰은 목록을 통째로 바꾼다(유실된 메시지가 다음 메시지로 저절로 복구된다). `groups`는 pane이 하나도 없는 herdr 세션(예: `rocket`)도 빈 그룹으로 보여 주기 위한 것이다.
  - `{type:"chat", sessionId, events}`: `watch_chat`한 세션의 transcript에 추가된 이벤트.
  - `{type:"frame", sessionId, frame}`: 터미널 프레임.
  - `{type:"terminal_status", sessionId, state: "live" | "restarting" | "ended"}`: 관찰자 스트림이 끊겨 다시 여는 중인지 알린다. 프레임은 화면이 바뀔 때만 오므로 이 메시지가 없으면 폰이 끊김을 알 수 없다.
  - `{type:"command_result", requestId, ok, error?}`: 명령 결과. `error`는 10.1절 오류 코드다.
- 폰이 WebSocket으로 붙어 있는 동안만 herdr를 폴링한다. 아무도 없으면 폴링과 관찰자를 모두 멈춘다.

### 7.2 herdr 클라이언트 규칙

- 세션 목록은 `herdr session list --json`으로 시작할 때 읽고, 1분마다 다시 읽는다.
- 소켓이 끊기면 지수 백오프로 재연결한다. 끊긴 동안 그 herdr 세션의 `Session`들은 `status: "unknown"`에 `unreachable` 표시를 붙인다(Session에 `reachable: boolean` 필드를 추가해도 된다).
- `agent.prompt`는 `wait` 없이 보낸다. 상태 변화는 폴링이 가져온다.
- `agent_blocked` 오류는 폰에 "Claude가 승인을 기다리는 중이라 메시지를 보내지 않았습니다"로 보여 준다. 다시 보내지 않는다.

## 8. 화면

네 화면이다. 목업: https://claude.ai/artifact/Ear2krffWbpSF4VvE3RWEy

경로는 `/login`, `/`, `/s/:source/:group/:paneId` 셋이다. 세션 경로에 `source`가 들어가므로 cmux 세션을 붙일 때 라우터를 고치지 않아도 된다.

0. **로그인.** 상세 목업: https://claude.ai/artifact/KPKEGWywRsWRFhRYRB3dYN
   - 요소: 앱 표시, 호스트 이름, "Tailscale 확인됨 · <로그인 계정>" 줄(1차 관문 통과 표시. 서버가 `tailscale whois`로 기기 이름을 알아내면 덧붙인다), 암호 입력란("보기" 토글 포함), "이 기기에서 30일 동안 로그인이 유지됩니다" 안내, 로그인 버튼. 아이디란은 화면에 없다.
   - 키체인: 입력란은 `type="password" autocomplete="current-password"`이고, 시각적으로 숨긴 `autocomplete="username"` 입력란에 Tailscale 로그인 값을 넣는다. iOS 키체인이 암호를 저장하고 다음부터 Face ID로 자동 완성한다. 1차의 Face ID 로그인은 이것으로 대신한다.
   - 틀렸을 때: "암호가 다릅니다. 남은 시도 n회." 입력은 비우지 않고 전체 선택 상태로 둔다. 움직임 효과는 없다.
   - 429일 때: 서버 응답의 `retry_after` 초로 버튼이 카운트다운하고 입력란을 비활성화한다. 0이 되면 다시 연다.
   - 깊은 링크: 로그인 전에 요청한 경로를 기억했다가 성공 후 그 경로로 간다.
   - 홈 화면 앱: `display-mode: standalone`이고 쿠키가 없을 때만 상단에 "홈 화면 앱은 Safari와 로그인 저장소가 달라서 한 번 더 로그인합니다" 띠를 보여 준다.
   - 403: Tailscale 관문에서 막힌 기기에는 로그인 화면 대신 "이 기기는 허용되지 않았습니다" 화면만 보여 준다. 암호를 시도할 기회를 주지 않는다.
   - 로그아웃: 목록 화면 메뉴에 "이 기기 로그아웃"과 "모든 기기 로그아웃"을 둔다. 메뉴의 "로그인 기록"은 최근 20건(시각, 성공 여부, 기기 종류)을 보여 준다.
1. **세션 목록.** herdr 세션별로 묶는다. 한 줄에 워크스페이스 라벨, 상태 표시, 제목, 짧은 경로(`~/.herdr/worktrees/rocket/remove-lab`). `blocked`는 맨 위, 테두리 강조. 상단에 "N 작업 중" 요약.
2. **대화.** 헤더에 뒤로가기, 라벨, 상태 표시, 탭(대화 | 터미널). 본문은 사용자 말풍선(오른쪽), Claude 말풍선(왼쪽), 접힌 도구 묶음 칩. `blocked`면 하단에 승인 카드(원문 텍스트 + 선택지 버튼). 하단 입력창은 6.2 표를 따른다. 새 이벤트가 오면 맨 아래에 있을 때만 자동 스크롤한다.
3. **터미널.** xterm.js 뷰를 pane 크기(예: 155×54)로 만든다. 기본은 폰 폭에 맞춰 통째로 축소해서 보여 준다(글자는 작지만 전체 화면과 프롬프트가 보인다). 상단 토글 "원래 크기"를 켜면 1:1 크기에 가로 스크롤이 된다. 가로 모드에서는 축소 비율만 다시 계산한다. 하단에 키 버튼 줄(Esc, Enter, Ctrl+C, ↑, ↓, Tab, 1, 2, 3)과 글자 입력란이 있다. 입력란의 글은 `raw_text`로 보내고 Enter는 붙이지 않으므로, 보낸 뒤 Enter 버튼을 눌러 확정한다. 이 입력란은 승인 대화상자에서 글로 답해야 할 때(예: "No, and tell Claude what to do differently", AskUserQuestion의 직접 입력) 쓴다. 대화 화면의 승인 카드에는 "글로 답하려면 터미널 탭에서 입력하세요" 안내를 둔다.

공통: 다크/라이트 모두 지원. 폰 safe area를 지킨다. 연결이 끊기면 상단에 띠로 알리고 자동 재접속한다.

## 9. herdr API 매핑

| 용도 | 메서드 / 명령 | 파라미터 | 비고 |
| --- | --- | --- | --- |
| herdr 세션 목록 | `herdr session list --json` | | 소켓 경로를 얻는다 |
| 상태 폴링 | `session.snapshot` | `{}` | `workspaces`, `agents`, `panes`, `tabs`, `layouts` |
| 세션 상세 | `agent.get` | `{target}` | target은 pane_id 또는 에이전트 이름 |
| 승인 화면 텍스트 | `agent.read` | `{target, source:"detection", format:"text", strip_ansi:true}` | source enum은 API에서 `recent_unwrapped`(밑줄), CLI에서 `recent-unwrapped`(하이픈) |
| 메시지 보내기 | `agent.prompt` | `{target, text}` | `blocked`면 `agent_blocked` 오류 |
| 키 보내기 | `agent.send_keys` (에이전트가 없는 pane에는 `pane.send_keys`) | `{target, keys:[...]}` / `{pane_id, keys}` | 키 이름 예: `enter`, `esc`, `ctrl+c`, `up`, `down`, `tab`, `1` |
| 터미널 화면 | `herdr terminal session observe <terminal_id> --cols N --rows N` | | 자식 프로세스. stdout이 줄 단위 JSON 프레임 |
| 살아있는지 | `ping` | `{}` | 재연결 판정 |

## 10. 보안

- 서버는 `127.0.0.1`에만 바인드한다. Tailscale Serve가 `https://macbookpro.tailfdccb7.ts.net`에서 이 포트로 프록시한다. `tailscale funnel`은 쓰지 않는다.
- 1차 관문: 모든 HTTP 요청과 WebSocket 업그레이드에서 `Tailscale-User-Login`이 설정의 소유자와 같아야 한다. 아니면 403. 개발용 우회는 환경 변수 `CONSOLE_DEV_NO_TAILSCALE=1`로만 켠다. 로그인 관문에는 우회가 없다.
- 2차 관문: `/api/login`, 로그인 화면의 정적 파일, manifest를 뺀 모든 요청과 WebSocket 업그레이드에 유효한 로그인 쿠키가 있어야 한다. 없으면 401이고, 앱은 로그인 화면으로 돌아간다.
- 암호는 scrypt(N=2^15, r=8, p=1, 16바이트 salt)로 해시해서 저장한다. 비교는 상수 시간 비교를 쓴다. 토큰은 32바이트 무작위 값이고, 서버에는 sha256만 저장한다.
- 쿠키는 `HttpOnly; Secure; SameSite=Strict; Path=/`이고 Max-Age는 30일이다. 개발용 HTTP 접속에서는 `Secure`를 뺀다.
- 로그인 실패는 IP당 분당 5회까지만 받고, 넘으면 429와 함께 60초를 기다리게 한다. IP는 `X-Forwarded-For`의 첫 값이고, 이 헤더는 같은 Mac의 다른 프로세스가 위조할 수 있으므로 전체 상한(분당 20회)을 함께 둔다.
- `POST /api/login`과 WebSocket 업그레이드에서 `Origin` 헤더가 설정의 공개 주소(`https://macbookpro.tailfdccb7.ts.net`)와 같아야 한다. 폰 Safari에서 연 다른 웹 페이지가 같은 쿠키나 같은 Tailscale 신원으로 이 서버에 요청을 보내는 것을 막기 위해서다. 개발용 주소는 환경 변수로 하나 더 허용한다.
- 폰에서 들어온 텍스트는 herdr에 그대로 넘긴다. 셸을 거치지 않는다(`agent.prompt`는 소켓 JSON이다). Claude 세션 id는 UUID 형식을 통과한 값만 브랜드 타입으로 만들어 파일 이름에 쓴다.

### 10.1 오류 코드

서버 안에서 모듈 경계를 넘는 오류는 아래 코드 하나뿐이다. herdr 오류 코드는 어댑터 안에서 이 코드로 바뀌고, 모르는 코드는 `source_error`가 된다. 폰 문구와 HTTP 상태는 코드별 표 하나에서 나온다.

`agent_blocked`(409, 재시도 금지), `agent_not_ready`(409), `delivery_unconfirmed`(504, 재시도 금지. 보낸 뒤 소켓이 끊겨 결과를 모름), `pane_closed`(410), `source_unreachable`(503, 자동 복구), `source_error`(502), `stale_dialog`(409, 다시 읽기), `stale_cursor`(410, 최신 페이지 다시 받기), `no_transcript`(404), `invalid_command`(400), `unauthorized`(401), `forbidden`(403), `wrong_passphrase`(401), `rate_limited`(429), `internal`(500).
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

1. Mac에서 `pnpm passphrase`로 암호를 정하고 `pnpm start`를 켠 뒤 `tailscale serve --bg <port>`를 등록한다. 아이폰 Safari로 `https://macbookpro.tailfdccb7.ts.net`에 들어가면 로그인 화면이 먼저 보인다. 틀린 암호는 거부되고, 맞는 암호를 넣으면 목록에 현재 herdr 에이전트들이 실제 라벨과 상태로 보인다. Safari를 완전히 닫았다가 다시 열어도 로그인 화면 없이 목록이 보인다.
1-1. 로그인 쿠키 없이 `curl -H 'Tailscale-User-Login: kkt629@gmail.com' http://127.0.0.1:<port>/api/sessions`를 치면 401이다. 틀린 암호로 `/api/login`을 6번 연속 치면 여섯 번째는 429다.
2. Mac에서 한 세션에 프롬프트를 쳐서 `working`으로 바꾸면 폰 목록이 2초 안에 바뀐다.
3. 폰에서 대기 중인 세션에 "현재 작업 디렉터리를 한 줄로 알려줘" 같은 메시지를 보내면, Mac의 Claude Code 화면에 그 메시지가 한 번 들어가고 응답이 폰 대화 화면에 나타난다.
4. Claude가 승인을 기다리는 상태를 만들고(예: 허용되지 않은 Bash 명령), 폰에 승인 카드가 뜨고, 버튼을 누르면 Mac 화면에서 그 선택지가 선택된다.
5. 터미널 탭이 Mac 화면과 같은 내용(프롬프트 줄 포함)을 보여 주고, Mac 쪽 터미널 크기와 포커스는 바뀌지 않는다(`herdr pane layout`과 `herdr agent list`의 `focused`로 전후 비교). 터미널 탭 입력란에 글을 쓰고 Enter를 누르면 Mac 화면의 입력줄에 그 글이 한 번만 들어간다.
6. 테일넷에 없는 기기(예: 셀룰러만 켠 폰, Tailscale 끔)에서는 접속되지 않는다. `Tailscale-User-Login` 헤더 없이 `curl http://127.0.0.1:<port>/api/sessions`를 치면 403이다.
7. 서비스를 10분 켜 둔 뒤 `herdr status`와 cmux가 정상이고, `claude` 프로세스 수가 그대로다.

### 12.1 시험 세션

12.3과 12.4처럼 입력을 보내는 검증은 사용자의 실제 작업 세션에 하지 않는다. 빌더는 herdr `default` 세션에 시험용 워크스페이스를 하나 만들고(`herdr workspace create --name console-test`, 작업 디렉터리는 비어 있는 임시 폴더), 거기에 `herdr agent start console-test --kind claude`로 Claude Code를 띄운 뒤, 그 세션에만 시험 입력을 보낸다. 승인 대기 상태는 그 폴더 안에서 `touch probe.txt` 같은 무해한 명령을 요청해서 만든다. 검증이 끝나면 `herdr workspace close`로 지운다. 이 시험 세션은 사용자의 Claude 사용량을 조금 쓰고, 그동안 사용자의 herdr 사이드바에 보인다. 시험 세션에서 확인할 것: 숫자 키 하나로 선택지가 확정되는지, `agent.send_keys`가 `1` 같은 글자 하나를 받는지, 선택지 파싱 정규식에 넣을 실제 화면 텍스트.

## 13. 빌더 점검 결과와 처리

빌더 점검(별도 에이전트)이 낸 질문 4개와 처리다.

| 질문 | 처리 |
| --- | --- |
| 암호 로그인을 1차 범위에 넣는가 | 넣는다. 사용자 결정(5.1). 2절, 5.2, 6.5, 7, 8.0, 10, 12에 반영했다. 추가로 Origin 검사를 10절에 넣었다. |
| `observe --cols/--rows`가 실제로 무엇을 하는가 | 직접 확인했다. 화면을 자르기만 하고 PTY 크기는 바꾸지 않는다(4.2). 관찰자는 pane 실제 크기로 열고 폰에서 축소해 보여 준다(5.2, 8.3). |
| 승인 대화상자에 글로 답하는 경우를 지원하는가 | 1차에서 터미널 탭의 입력란으로만 지원한다(`pane.send_text`, 5.2의 예외). 대화 화면 입력창은 `blocked`일 때 계속 비활성이다. 작성자 결정. |
| 시험 입력을 어느 세션에 보내는가 | 사용자의 실제 세션에는 보내지 않는다. 시험용 워크스페이스를 만들어 쓰고 지운다(12.1). **시험 세션을 만드는 것은 사용자 확인이 필요하다.** |
