/**
 * The only error codes that cross a module boundary (spec 10.1). ErrorCode, the HTTP status, the phone text and
 * the retry policy all come from this one table. Sources translate their own codes into it inside the adapter.
 * `retry`: "never" means a resend may duplicate input; "refresh" means read the state again first;
 * "auto" means the system recovers by itself.
 */
export const ERROR_INFO = {
  agent_blocked: { http: 409, retry: "never", phone: "Claude가 승인을 기다리는 중이라 메시지를 보내지 않았습니다." },
  agent_not_ready: { http: 409, retry: "never", phone: "Claude가 아직 입력을 받을 준비가 되지 않았습니다. 잠시 뒤에 다시 보내세요." },
  delivery_unconfirmed: { http: 504, retry: "never", phone: "전달되었는지 확인하지 못했습니다. Mac 화면을 확인한 뒤에 다시 보내세요." },
  pane_closed: { http: 410, retry: "never", phone: "세션이 닫혔습니다." },
  source_unreachable: { http: 503, retry: "auto", phone: "herdr에 연결할 수 없습니다. 연결되면 자동으로 복구됩니다." },
  source_error: { http: 502, retry: "never", phone: "herdr가 요청을 거부했습니다. Mac 화면을 확인하세요." },
  stale_dialog: { http: 409, retry: "refresh", phone: "승인 화면이 바뀌어서 선택을 보내지 않았습니다. 화면을 다시 확인하세요." },
  stale_cursor: { http: 410, retry: "refresh", phone: "대화 기록이 바뀌어서 최신 기록부터 다시 읽습니다." },
  no_transcript: { http: 404, retry: "never", phone: "이 세션의 대화 기록 파일을 찾지 못했습니다. 터미널 탭을 사용하세요." },
  invalid_command: { http: 400, retry: "never", phone: "요청 형식이 올바르지 않습니다." },
  unauthorized: { http: 401, retry: "never", phone: "로그인이 필요합니다." },
  forbidden: { http: 403, retry: "never", phone: "이 기기는 허용되지 않았습니다." },
  wrong_passphrase: { http: 401, retry: "never", phone: "암호가 다릅니다." },
  rate_limited: { http: 429, retry: "auto", phone: "시도 횟수를 넘었습니다. 잠시 뒤에 다시 시도하세요." },
  internal: { http: 500, retry: "never", phone: "서버에서 오류가 발생했습니다." },
} as const satisfies Record<string, { http: number; retry: "never" | "refresh" | "auto"; phone: string }>;

export type ErrorCode = keyof typeof ERROR_INFO;

/** Errors as values across module boundaries. A bare `Result` is the success or failure of one command. */
export type Result<T extends object = Record<never, never>> = ({ ok: true } & T) | { ok: false; error: ErrorCode };
