import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseClaudeSessionId } from "#shared/domain";
import type { ClaudeSessionId } from "#shared/domain";

/**
 * Running Claude Code processes, by pid. Claude Code 2.1 writes `~/.claude/sessions/<pid>.json` with
 * `{pid, sessionId, cwd, startedAt, ...}` for every interactive session (measured on 2.1.319 and 2.1.322), so a
 * source that knows the agent's pid but not its session (hc) gets the session id from here, never from cwd
 * (spec 4.4).
 */
export interface ClaudeProcesses {
  /** The session id of the Claude process `pid`, or null when no record names that pid. Never rejects. */
  sessionIdOf(pid: number): Promise<ClaudeSessionId | null>;
}

export function createClaudeProcesses(dir: string): ClaudeProcesses {
  return {
    async sessionIdOf(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return null;
      try {
        const record: unknown = JSON.parse(await readFile(join(dir, `${pid}.json`), "utf8"));
        if (typeof record !== "object" || record === null) return null;
        const { pid: recorded, sessionId } = record as { pid?: unknown; sessionId?: unknown };
        // A file left by an exited process whose pid was reused is rewritten by the new process; the pid check
        // guards the window before that, when the file still describes the old one by name only.
        return recorded === pid ? parseClaudeSessionId(sessionId) : null;
      } catch {
        return null;
      }
    },
  };
}
