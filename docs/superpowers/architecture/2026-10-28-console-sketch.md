# 모바일 세션 콘솔 설계 스케치

- 작성일: 2026-10-28
- 계약: `docs/superpowers/specs/2026-10-28-mobile-session-console-design.md`의 5, 6, 7, 8, 9, 10절(10.1 오류 코드 포함). 이 문서와 설계서가 다르면 설계서가 우선한다.
- 상태: 타입, 시그니처, 불변식 주석, `not implemented` 본문으로 이루어진 뼈대이다. `pnpm check`가 통과한다.

## Usage (caller's view)

### 소유자용 빠른 시작

```sh
pnpm install
pnpm passphrase            # 암호를 두 번 받아 config.json(0600)에 scrypt 해시만 쓰고, revoked-by-cli 표지를 갱신해 기존 로그인을 모두 무효로 한다
pnpm start                 # web을 빌드한 뒤 127.0.0.1:7420에서 서버를 전경으로 실행한다
tailscale serve --bg 7420  # 실패하면 오류 문구를 그대로 읽는다(HTTPS 인증서를 켜지 않았을 가능성이 높다)
pnpm revoke-all            # 폰을 잃어버렸을 때 실행한다. 살아 있던 로그인의 기기와 시각을 출력하고, 서버가 꺼져 있어도 동작한다
pnpm dev                   # 1차 관문만 끈 서버(CONSOLE_DEV_NO_TAILSCALE=1)와 Vite(:5173)를 함께 띄운다. 2차 관문은 그대로이다
pnpm check                 # 서버와 웹 타입 검사, 그리고 node --test(모듈 경계 검사 포함)
```

스크립트 이름을 `setup`으로 두지 않은 이유는 pnpm 11이 내장 명령 `pnpm setup`을 먼저 실행하기 때문이다(설계서 5.2).

### 호출 지점 1: 허브가 승인 버튼의 `keys` 명령을 처리한다

```ts
// server/src/hub.ts, ws "message" 처리기
if (!deps.auth.isTokenLive(c.token)) return c.ws.close(4401, "logged_out");
const parsed = parseCommand(String(data));                     // CommandSchema(zod)가 타입과 검증과 길이 제한의 원천이다
if (!parsed.ok) return parsed.requestId && send(c, { type: "command_result", requestId: parsed.requestId, ok: false, error: "invalid_command" });
const { command } = parsed;
const hit = recent.get(command.requestId) ?? remember(command.requestId, execute(c, command, deps));  // 2분 동안 소켓과 무관하게 유지한다
send(c, { type: "command_result", requestId: command.requestId, ...(await hit.result) });

// execute() 안. 폰은 { type: "keys", keys: ["1"], guard: { dialogId } }를 보냈다
const read = await source.readDialog(session);                 // 보내기 직전에 detection 텍스트를 다시 읽는다
if (!read.ok) return read;
if (dialogId(read.text) !== cmd.guard.dialogId) return { ok: false, error: "stale_dialog" };
return source.send(session, cmd);                              // herdr: agent.send_keys. 쓴 뒤 응답을 잃으면 delivery_unconfirmed
```

폰은 `ERROR_INFO.stale_dialog.phone`을 토스트로 보여 주고, `retry: "refresh"`에 따라 승인 화면을 다시 읽는다.

### 호출 지점 2: 레지스트리가 폴링 결과를 전체 목록으로 바꾼다

```ts
// server/src/sessions.ts, pollOnce()
const polls = await Promise.all(deps.sources.map((s) => s.poll()));   // SourcePoll { groups, sessions }. poll은 reject하지 않는다
const rows = polls.flatMap((p) => p.sessions);
const sessions = await Promise.all(rows.map(async (r) => ({ ...r, transcriptPath: r.claudeSessionId ? await deps.transcripts.locate(r.claudeSessionId) : null })));
const diff = diffSessions(byId, sessions);
list = { groups: polls.flatMap((p) => p.groups), sessions };

// server/src/hub.ts, registry.subscribe 처리기
broadcast({ type: "sessions", ...list });     // 항상 전체 목록이다. 폰은 통째로 바꾸고, 빈 그룹(rocket)도 groups로 보인다
diff.removed.forEach(closeTerminalsOf);
demand();                                     // 따라갈 transcript 집합을 다시 계산한다
```

### 호출 지점 3: 대화 화면이 위로 스크롤하면 이전 이벤트를 읽는다

```ts
// web/src/store.ts
export async function loadOlder(id: SessionId): Promise<void> {
  const t = state.value.chat.get(id);
  if (!t || t.exhausted || t.loadingOlder) return;
  dispatch({ type: "chat_older_loading", sessionId: id, loading: true });
  const events = await api("GET /api/sessions/:id/chat", { id, query: { before: t.events[0]?.uuid, limit: 50 } });  // 인자 타입은 ApiContract에서 나온다
  if (!events) return dispatch({ type: "chat_older_loading", sessionId: id, loading: false });            // api()가 이미 알렸다
  dispatch({ type: "chat_page", sessionId: id, claudeSessionId: t.claudeSessionId, events, limit: 50, older: true });
}
// 서버의 ROUTES 항목은 ChatQuery로 쿼리를 파싱한 뒤 transcripts.page(cid, before, limit)를 부른다.
```

## Problem

아이폰 Safari에서 Mac의 herdr 안에서 실행 중인 Claude Code 세션을 보고, 대화를 이어 가고, 승인 요청에 답하는 테일넷 전용 웹 앱을 만든다. 데이터는 갱신 주기와 실패 방식이 서로 다른 세 경로(`session.snapshot` 폴링, transcript 파일 증분 읽기, `terminal session observe` 자식 프로세스)로 들어온다. 실패 조건은 "메시지가 두 번 들어간다"와 "승인 버튼이 다른 선택지에 눌린다"를 금지하므로, 재전송과 경쟁 상태를 구조로 막아야 한다. 서버와 CLI는 서로 다른 프로세스인데 같은 로그인 상태를 다룬다. 2차의 cmux 어댑터는 허브와 웹을 고치지 않고 붙어야 한다.

## Shape

### 자료 구조

- `Session = SessionFacts & Liveness & { transcriptPath }`이다(`shared/domain.ts`). `Liveness`가 `{reachable: true; status: AgentStatus} | {reachable: false; status: "unknown"}`이므로, 끊긴 그룹의 행이 "작업 중"을 말하는 상태는 컴파일되지 않는다(per type-system-discipline). 필드는 모두 원시 값이라서 `diffSessions`가 필드 목록 없이 비교한다.
- `SessionList = { groups, sessions }`가 `sessions` 메시지와 레지스트리의 상태이다. pane이 없는 herdr 세션도 `groups`에 남는다.
- `SessionId`, `ClaudeSessionId`, `RequestId`, `TokenHash`는 브랜드 타입이다. `ClaudeSessionId`는 UUID 검사를 통과해야만 만들어지므로 파일 이름에 써도 경로 조작이 생기지 않는다.
- 오류는 `Result` 값으로 경계를 넘고, 코드 집합은 `shared/errors.ts`의 `ERROR_INFO` 하나이다. `ErrorCode`, HTTP 상태, 폰 문구, 재시도 정책이 모두 이 표에서 나온다(설계서 10.1).
- `CommandSchema`(zod)가 WS 명령 타입과 서버 검증과 길이 제한을 함께 정한다. `ApiContract`는 라우트마다 `{req?, query?, res}`를 두고, `req`와 `query`는 zod 스키마 타입이다. 서버 라우트 표는 그 스키마 값을 반드시 들고 있어야 컴파일되고, 웹 `api()`는 같은 항목에서 인자 타입을 얻는다.

### 모듈과 소유 상태

| 모듈 (별칭) | 소유하는 상태 | 숨기는 일 |
| --- | --- | --- |
| `#config` (`config.ts`) | 없음. 경로 표와 `fileCell` | 파일마다 쓰는 프로세스가 하나라는 규칙, 원자적 rename, mtime 캐시 |
| `#auth` (`auth.ts`) | tokens.json(유일한 쓰기 주체), revoked-by-server, 실패 횟수, 로그인 기록 | scrypt, 토큰 발급, 쿠키 형식, Origin, IP 판정, `isLive` |
| `#source` (`source.ts`) | 없음. 어댑터 계약 | |
| `#herdr` (`herdr/`) | herdr 세션 목록, 세션별 소켓과 마지막 스냅샷, 관찰자 | 메서드 이름, 스냅샷 필드, pane 크기, 오류 코드 변환 |
| `#claude` (`claude/`) | 파일마다 `TranscriptWindow` 하나 | 파일 찾기, 역방향 읽기, 증분 읽기, 레코드 필터, 선택지 파싱, `dialogId` |
| `#sessions` (`sessions.ts`) | 현재 `SessionList`, 폴링 타이머, generation | single flight 폴링, 꺼짐과 켜짐 경쟁 |
| `#hub` (`hub.ts`) | 클라이언트 집합, 클라이언트별 관찰자, `requestId` 캐시 | 파생 `demand()`, 하트비트, 백프레셔, 토큰 재검사, 승인 보호 |
| `#http` (`http.ts`) | 없음 | 두 관문, Origin, 스키마 파싱, 정적 파일, WS 업그레이드 |

모듈 밖에서는 별칭만 import할 수 있다. `server/src/boundaries.test.ts`는 상대 경로가 모듈 경계를 넘거나, `shared`가 바깥을 import하거나, 웹이 서버 모듈에 닿으면 실패한다(per encode-lessons-in-structure).

### 핵심 결정

1. **허브는 파생된 수요만 가진다.** 폴링과 transcript 따라가기는 클라이언트가 있는 동안에만 켜지고, 따라갈 집합은 `registry.current()`에서 매번 다시 계산한다. 참조 계수가 없으므로 두 번 실행해도 결과가 같다(per make-operations-idempotent).
2. **관찰자는 클라이언트와 세션 쌍마다 하나이다.** 소켓이 닫히면 그 클라이언트가 연 관찰자만 닫힌다. 스트림 상태는 `terminal_status`의 `live | restarting | ended`로 알린다.
3. **대화는 서버가 따라가서 모든 클라이언트에 보낸다.** 폰은 uuid 합집합(`mergeEvents`)으로 합치므로 GET 페이지와 push의 도착 순서를 신경 쓰지 않는다. 화면에 없는 스레드는 최근 500개만 남긴다.
4. **입력은 최대 한 번만 전달한다.** 허브는 `requestId`를 2분 동안 기억하고, 어댑터는 쓴 뒤 응답을 잃은 호출을 `delivery_unconfirmed`로 돌려준다. 폰의 `Pending.phase`는 사실(`sending | delivered | failed`)만 담고, 화면 문구는 `pendingLabel`이 렌더할 때 정한다.
5. **승인 보호는 두 겹이다.** 폰은 `forSeq`가 현재 `stateChangeSeq`와 같을 때만 버튼을 보이고, 서버는 보내기 직전에 `dialogId`를 다시 비교한다.
6. **상태 파일마다 쓰는 프로세스가 하나이다.** config.json은 `pnpm passphrase`만, tokens.json은 서버만 쓴다. 폐기는 시각 표지로 하고 CLI와 서버가 각자 자기 표지 파일만 쓴다. `isLive(session, revokedBefore, now)` 하나가 서버, `pnpm revoke-all`, 테스트에서 쓰인다(per separate-before-serializing-shared-state).

경계 검증은 `parseCommand`, `ApiContract` 스키마, `parseSessionId`, `parseClaudeSessionId`, `readSnapshot`, 관찰자 프레임 검사, `lineToEvents`, `fileCell`의 스키마에만 있다. 안쪽 코드는 타입을 신뢰한다(per boundary-discipline).

## Synthesis decision

**기준안은 candidate-opus이다.** 오케스트레이터 채점은 opus 16, sonnet 18이었고 교차 심사는 opus 17, sonnet 16이었다. 의견이 갈린 원인은 루브릭의 "설계서가 고정한 결정을 바꾼 경우 감점" 문구가 모호했던 점과, 대화 열기가 두 단계(watch 뒤 GET)인 sonnet의 인터페이스를 가볍게 본 점이었다. 이 두 요인을 반영하면 두 후보는 거의 동점이고, 아레나 규칙에 따라 API가 더 작은 opus를 골랐다. 교차 심사의 결론도 같았다.

candidate-sonnet에서 옮겨 심은 것은 다음 열한 가지이다.

1. `Liveness` 합 타입으로 "끊기면 unknown"을 타입으로 만들었다.
2. 서버 쪽 승인 보호(`keys.guard.dialogId`, `BlockedDialog.dialogId`, `dialogId(text)`, 보내기 직전의 `stale_dialog` 검사)를 넣었다. opus의 `forSeq`는 폰 쪽 보호로 남겼다.
3. 폐기 표지 파일 두 개, `isLive`, `fileCell`을 넣고 서버를 tokens.json의 유일한 쓰기 주체로 정했다.
4. `ERROR_INFO` 표 하나가 opus의 `STATUS`와 `ERROR_TEXT`를 대신한다. 오류 전달은 opus대로 `Result` 값이다.
5. `pendingLabel`을 렌더할 때 계산하고 `pending_expired` 액션을 없앴다.
6. 허브에 `requestId` 중복 방지 캐시(2분, 소켓과 무관)를 두었다.
7. `HERDR_KEY` 문법과 `KEY_PRESETS` 표를 넣었다. KeyBar와 승인 카드의 범용 키가 같은 표를 읽는다.
8. zod 스키마가 `Command` 타입과 HTTP 본문의 원천이다. 손으로 쓴 `parseCommand` 검증을 대신한다.
9. `ApiContract`가 서버 라우트 표와 웹 `api()`를 함께 타이핑한다.
10. package.json `imports` 별칭과 `boundaries.test.ts`가 `scripts/check-boundaries.ts`를 대신한다.
11. `terminal_reopening` 대신 `terminal_status`(`live | restarting | ended`)를 쓴다.

버린 것은 다음과 같다. sonnet의 `watch_chat`/`unwatch_chat`은 서버 주도 따라가기가 폰의 순서 규칙을 없애므로 버렸다. `createSharedPool`과 관찰자 공유는 클라이언트별 관찰자가 재생 버퍼 없이 더 단순하므로 버렸다. `ConsoleError` 예외 전파는 `Result` 값이 경계를 더 잘 드러내므로 버렸다. `Hub.chatPage/blocked` 경유는 HTTP 라우트가 레지스트리와 transcript를 직접 부르는 쪽이 호출 사슬이 짧으므로 버렸다. opus에서는 `pending_expired` 타이머, `STATUS`/`ERROR_TEXT` 분리, 서버와 CLI가 함께 쓰는 토큰 파일, 손으로 쓴 `parseCommand`, `scripts/check-boundaries.ts`를 버렸다.

합성하면서 기준안을 다음과 같이 고쳤다. 별칭 하나가 모듈 하나를 가리키도록 `sources/source.ts`와 `sources/herdr/`를 `source.ts`와 `herdr/`로 올렸다. `fileCell`은 파일이 하나뿐인 `lib/` 대신 상태 디렉터리를 소유한 `config.ts`에 두었다. opus의 `Auth.onRevoked`(디렉터리 감시)는 허브가 명령마다, 그리고 15초 하트비트마다 `isTokenLive`를 묻는 방식으로 바꿨다. 1차 관문 실패는 정적 파일에도 403이므로 웹 번들이 그 기기에 실리지 않는다. 그래서 opus의 `DeniedScreen`을 지우고, 서버의 403 응답 본문이 설계서 8.0절의 "이 기기는 허용되지 않았습니다" 화면이 되게 했다. 웹 의존성은 설계서의 스택으로 줄이려고 markdown-it을 뺐고, Claude 응답은 줄바꿈을 살린 평문으로 보인다.

## Tradeoffs accepted

- 폐기된 폰의 소켓이 최대 15초 동안 push를 더 받는 지연을 감수하고, 상태 디렉터리 감시와 리스너 집합을 없앤다. 그 소켓이 보내는 명령은 즉시 거부된다.
- 보호된 키마다 `agent.read` 한 번을 더 부르는 비용을 감수하고, 1.5초 폴링 간격 안에서 바뀐 대화상자에 옛 선택이 들어가는 경쟁을 없앤다.
- 폰이 보고 있지 않은 세션의 대화까지 받는 전송량을 감수하고, 대화 구독 명령과 순서 규칙을 없앤다.
- 같은 터미널을 두 클라이언트가 보면 관찰자가 둘이 되는 비용을 감수하고, 참조 계수와 재생 버퍼를 없앤다.
- `pnpm revoke-all`이 tokens.json을 바로 비우지 않는 점을 감수한다. 표지 이전에 만든 토큰은 그 순간부터 무효이고, 파일의 항목은 서버가 다음에 쓸 때 지운다. 그 대가로 두 프로세스가 같은 파일을 쓰지 않는다.
- zod를 서버 런타임 의존성으로 들인다. 그 대가로 경계 검증 코드가 짧아지고 타입이 스키마에서 나온다.

## Alternatives considered

- **터미널마다 관찰자 하나를 공유하고 참조 계수로 관리하는 방식.** 늦게 붙은 구독자를 위해 마지막 전체 화면과 이후 델타를 보관해야 하므로, 허브가 버퍼 크기와 구독자별 진행 위치를 알아야 한다. 숨기는 것보다 드러내는 것이 많다.
- **목록의 변경분만 보내는 방식.** 폰이 순서에 민감한 패치 로직을 가져야 하고, 재접속할 때는 어차피 전체 목록이 필요하다. 같은 일을 하는 방법이 둘이 된다.
- **CLI가 tokens.json을 직접 고치는 방식.** 서버가 낡은 메모리로 파일을 다시 쓰면 폐기한 토큰이 되살아난다. 쓰기 주체를 나누는 쪽이 잠금 없이 이 경쟁을 없앤다.

## Open questions and risks

1. `GET /api/me`를 2차 관문 없이 열어도 됩니까? 설계서 7절과 7.1절은 `/api/login`만 열린 API라고 적지만, `loggedIn: false`를 돌려주려면 로그인하지 않은 요청에도 답해야 합니다. 이 경로는 요청자 자신의 Tailscale 계정과 기기 이름만 돌려줍니다.
2. 화면에 없는 스레드에만 500개 상한을 적용해도 됩니까? 열어 둔 스레드까지 자르면 위로 스크롤해 읽은 이벤트가 바로 사라집니다.
3. Origin 검사를 `POST /api/login`과 WS 업그레이드뿐 아니라 모든 POST에 적용했습니다. 이대로 두어도 됩니까?
4. herdr가 대상 없음과 잘못된 키 이름에 쓰는 실제 오류 코드는 무엇입니까? 지금은 `source_error`로 바뀝니다. 12.1절 시험 세션에서 확인해야 합니다. `agent.send_keys`가 `1`을 글자 하나로 받는지도 같은 시험에서 확인합니다.
5. Tailscale Serve가 `X-Forwarded-For`를 붙인다는 것은 추정입니다. 붙이지 않으면 IP별 제한이 전체 제한과 같아지고 `tailscale whois`로 기기 이름을 얻을 수 없습니다.
6. 홈 화면 아이콘(`icon-512.png`)은 아직 없습니다. 어떤 그림을 쓸지 정해 주시겠습니까?

## Next implementation step

`fileCell`, `readSnapshot`, `lineToEvents`를 실제 `snapshot.json`과 transcript 일부를 고정 입력으로 쓰는 `node --test` 테스트와 함께 먼저 구현한다.
