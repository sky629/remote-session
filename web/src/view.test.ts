import { describe, expect, test } from "vitest";
import type { AgentStatus, ChatEvent, ClaudeSessionId, Session, SessionGroup, SessionId } from "#shared/domain";
import { echoMatches, groupSessions, mergeEvents, relativeTime, renderMarkdown, shortPath, toBubbles } from "./view.ts";

function session(paneId: string, status: AgentStatus, stateChangeSeq: number, group = "default"): Session {
  return {
    id: `herdr:${group}/${paneId}` as SessionId,
    source: "herdr",
    group,
    paneId,
    terminalId: `term_${paneId}`,
    workspaceLabel: paneId,
    title: null,
    cwd: null,
    agent: "claude",
    claudeSessionId: null as ClaudeSessionId | null,
    stateChangeSeq,
    transcriptPath: null,
    reachable: true,
    status,
  };
}

const user = (uuid: string, ts: string, text = uuid): ChatEvent => ({ kind: "user_text", uuid, ts, text });
const use = (uuid: string, ts: string, toolUseId: string, name: string): ChatEvent => ({ kind: "tool_use", uuid, ts, toolUseId, name, summary: `${name}: x` });
const result = (uuid: string, ts: string, toolUseId: string, isError = false): ChatEvent => ({ kind: "tool_result", uuid, ts, toolUseId, isError, preview: "out" });
const assistant = (uuid: string, ts: string): ChatEvent => ({ kind: "assistant_text", uuid, ts, text: uuid });

describe("groupSessions", () => {
  const groups: SessionGroup[] = [
    { source: "herdr", name: "default", reachable: true },
    { source: "herdr", name: "rocket", reachable: true },
  ];

  test("sorts by status rank, then stateChangeSeq descending", () => {
    const rows = [
      session("w1:p1", "idle", 10),
      session("w2:p1", "working", 5),
      session("w3:p1", "blocked", 1),
      session("w4:p1", "done", 30),
      session("w5:p1", "unknown", 99),
      session("w6:p1", "working", 50),
    ];
    const [view] = groupSessions(groups, rows);
    expect(view!.sessions.map((s) => s.paneId)).toEqual(["w3:p1", "w6:p1", "w2:p1", "w4:p1", "w1:p1", "w5:p1"]);
  });

  test("keeps empty groups in the server's order and labels them", () => {
    const views = groupSessions(groups, [session("w1:p1", "idle", 1)]);
    expect(views.map((v) => [v.label, v.sessions.length])).toEqual([
      ["herdr · default", 1],
      ["herdr · rocket", 0],
    ]);
    expect(groupSessions([...groups].reverse(), []).map((v) => v.group.name)).toEqual(["rocket", "default"]);
  });

  test("puts each session into its own group", () => {
    const views = groupSessions(groups, [session("w1:p1", "idle", 1, "rocket"), session("w2:p1", "idle", 2, "default")]);
    expect(views.map((v) => v.sessions.map((s) => s.paneId))).toEqual([["w2:p1"], ["w1:p1"]]);
  });
});

describe("mergeEvents", () => {
  test("drops uuids already present and returns the base itself when nothing is new", () => {
    const base = [user("a", "2026-01-01T00:00:01Z"), user("b", "2026-01-01T00:00:02Z")];
    expect(mergeEvents(base, [user("b", "2026-01-01T00:00:02Z")])).toBe(base);
    expect(mergeEvents(base, [])).toBe(base);
  });

  test("orders by ts regardless of arrival order", () => {
    const merged = mergeEvents([user("c", "2026-01-01T00:00:03Z")], [user("a", "2026-01-01T00:00:01Z"), user("b", "2026-01-01T00:00:02Z")]);
    expect(merged.map((e) => e.uuid)).toEqual(["a", "b", "c"]);
  });

  test("keeps arrival order on equal ts", () => {
    const ts = "2026-01-01T00:00:01Z";
    const merged = mergeEvents([user("x", ts)], [user("y", ts), user("z", ts)]);
    expect(merged.map((e) => e.uuid)).toEqual(["x", "y", "z"]);
  });

  test("dedupes within the incoming batch", () => {
    const merged = mergeEvents([], [user("a", "2026-01-01T00:00:01Z"), user("a", "2026-01-01T00:00:01Z")]);
    expect(merged).toHaveLength(1);
  });

  test("a page and a push give the same set in either order", () => {
    const page = [user("a", "2026-01-01T00:00:01Z"), user("b", "2026-01-01T00:00:02Z")];
    const push = [user("b", "2026-01-01T00:00:02Z"), user("c", "2026-01-01T00:00:03Z")];
    expect(mergeEvents(mergeEvents([], page), push).map((e) => e.uuid)).toEqual(mergeEvents(mergeEvents([], push), page).map((e) => e.uuid));
  });
});

describe("echoMatches", () => {
  const cases: { name: string; sent: string; echoed: string; want: boolean }[] = [
    { name: "identical text", sent: "현재 디렉터리를 알려줘", echoed: "현재 디렉터리를 알려줘", want: true },
    { name: "different text", sent: "하나", echoed: "둘", want: false },
    { name: "NFD vs NFC Hangul", sent: "한글".normalize("NFD"), echoed: "한글".normalize("NFC"), want: true },
    { name: "CRLF vs LF", sent: "a\r\nb", echoed: "a\nb", want: true },
    { name: "outer whitespace and inner runs", sent: "  a   b\t c \n", echoed: "a b c", want: true },
    { name: "pasted_content wrapper", sent: "긴 본문\n둘째 줄", echoed: '<pasted_content id="p1">\n긴 본문\n둘째 줄\n</pasted_content>', want: true },
    { name: "wrapper around a part", sent: "앞 본문 뒤", echoed: '앞 <pasted_content id="p1">본문</pasted_content> 뒤', want: true },
    { name: "queued messages joined into one record", sent: "두 번째", echoed: "첫 번째\n두 번째\n세 번째", want: true },
    { name: "multi-line message inside a joined record", sent: "a\nb", echoed: "x\na\nb\ny", want: true },
    { name: "substring of a line is not a whole line", sent: "두 번째", echoed: "첫 번째\n두 번째 이야기\n", want: false },
    { name: "lines out of order", sent: "a\nb", echoed: "b\na", want: false },
    { name: "empty sent text never matches", sent: " \n ", echoed: "anything", want: false },
  ];
  test.each(cases)("$name", ({ sent, echoed, want }) => {
    expect(echoMatches(sent, echoed)).toBe(want);
  });
});

describe("toBubbles", () => {
  test("joins consecutive tool events into one run and pairs results by toolUseId", () => {
    const bubbles = toBubbles([
      user("u1", "2026-01-01T00:00:01Z"),
      use("t1", "2026-01-01T00:00:02Z", "tu1", "Bash"),
      use("t2", "2026-01-01T00:00:03Z", "tu2", "Bash"),
      result("r2", "2026-01-01T00:00:04Z", "tu2"),
      result("r1", "2026-01-01T00:00:05Z", "tu1", true),
      use("t3", "2026-01-01T00:00:06Z", "tu3", "Edit"),
      use("t4", "2026-01-01T00:00:07Z", "tu4", "Bash"),
      assistant("a1", "2026-01-01T00:00:08Z"),
    ]);
    expect(bubbles.map((b) => b.kind)).toEqual(["user", "tools", "assistant"]);
    const tools = bubbles[1]!;
    if (tools.kind !== "tools") throw new Error("expected a tools bubble");
    expect(tools.counts).toBe("Bash ×3 · Edit ×1");
    expect(tools.key).toBe("tools:t1");
    expect(tools.items.map((i) => [i.use.toolUseId, i.result?.uuid])).toEqual([
      ["tu1", "r1"],
      ["tu2", "r2"],
      ["tu3", undefined],
      ["tu4", undefined],
    ]);
    expect(tools.items[0]!.result?.isError).toBe(true);
  });

  test("text between tool calls splits the runs", () => {
    const bubbles = toBubbles([use("t1", "2026-01-01T00:00:01Z", "a", "Read"), assistant("a1", "2026-01-01T00:00:02Z"), use("t2", "2026-01-01T00:00:03Z", "b", "Read")]);
    expect(bubbles.map((b) => (b.kind === "tools" ? b.counts : b.kind))).toEqual(["Read ×1", "assistant", "Read ×1"]);
  });

  test("a result attaches to its use in an earlier run and a result without a use is left out", () => {
    const bubbles = toBubbles([
      result("orphan", "2026-01-01T00:00:00Z", "gone"),
      use("t1", "2026-01-01T00:00:01Z", "a", "Read"),
      assistant("a1", "2026-01-01T00:00:02Z"),
      result("r1", "2026-01-01T00:00:03Z", "a"),
    ]);
    expect(bubbles.map((b) => b.kind)).toEqual(["tools", "assistant"]);
    const tools = bubbles[0]!;
    if (tools.kind !== "tools") throw new Error("expected a tools bubble");
    expect(tools.items).toHaveLength(1);
    expect(tools.items[0]!.result?.uuid).toBe("r1");
  });
});

describe("display helpers", () => {
  test.each([
    ["/Users/kang/.herdr/worktrees/rocket/remove-lab", "~/.herdr/worktrees/rocket/remove-lab"],
    ["/Users/kang", "~"],
    ["/opt/homebrew", "/opt/homebrew"],
    [null, ""],
  ])("shortPath(%s)", (cwd, want) => {
    expect(shortPath(cwd)).toBe(want);
  });

  test.each([
    [5_000, "방금"],
    [59_000, "방금"],
    [60_000, "1분 전"],
    [3_599_000, "59분 전"],
    [7_200_000, "2시간 전"],
    [172_800_000, "2일 전"],
  ])("relativeTime(+%dms)", (elapsed, want) => {
    expect(relativeTime(1_000_000, 1_000_000 + elapsed)).toBe(want);
  });
});

describe("renderMarkdown", () => {
  test("renders markdown but leaves raw HTML as escaped text", () => {
    const html = renderMarkdown("**bold** <script>alert(1)</script> <img src=x onerror=alert(1)>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toMatch(/<script|<img/);
  });

  test("refuses javascript: links and images", () => {
    expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain("href");
    expect(renderMarkdown("![x](https://example.com/a.png)")).not.toContain("<img");
  });

  test("opens links outside the app without a referrer to it", () => {
    expect(renderMarkdown("[x](https://example.com)")).toContain('target="_blank" rel="noopener noreferrer"');
  });

  test("turns a bare URL into a link that opens outside the app, and keeps single line breaks", () => {
    const html = renderMarkdown("see https://claude.ai/artifact/abc\nnext");
    expect(html).toContain('<a href="https://claude.ai/artifact/abc" target="_blank" rel="noopener noreferrer">https://claude.ai/artifact/abc</a>');
    expect(html).toContain("<br>");
  });
});
