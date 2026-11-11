import { basename } from "node:path";
import { z } from "zod";
import { makeSessionId } from "#shared/domain";
import type { AgentStatus } from "#shared/domain";
import type { SourceSession } from "#source";

export interface HcView {
  rows: SourceSession[];
  /** Terminal size by address. Observers do not resize (`hc attach --observe`), so frames are cut to this size. */
  size: ReadonlyMap<string, { cols: number; rows: number }>;
}

export class TerminalListError extends Error {}

const optionalText = z.string().nullish();
/** The fields of `hc schema` Terminal this adapter reads; herdr-core adds more and they pass through unread. */
const Terminal = z.object({
  address: z.string().min(1),
  state: z.string(),
  cwd: z.string(),
  cols: z.number().int(),
  rows: z.number().int(),
  title: optionalText,
  labels: z.record(z.string(), z.string()).default({}),
  parent: optionalText,
  /** The OSC 7501 root record: the program's own words, "claude-code" and idle/working/blocked/done/error (measured). */
  status: z.object({ app: optionalText, state: z.string() }).nullish(),
  status_ms: z.number().int().nullish(),
  foreground: z.object({ pid: z.number().int(), cwd: z.string() }).nullish(),
});
const ListResult = z.object({ terminals: z.array(Terminal) });

const STATUSES = new Set<string>(["idle", "working", "blocked", "done"] satisfies AgentStatus[]);
/** The label the Herdr app puts on every terminal it shows (AGENTS.md: "A terminal with those labels shows up there"). */
export const APP_LABEL = "herdr.space";
/** hc reports the program's own name; the console's agent names follow herdr ("claude"), which the chat tab keys on. */
const AGENTS: Readonly<Record<string, string>> = { "claude-code": "claude" };

/**
 * Turns one `terminal.list` result into rows: the live terminals the Herdr app shows, one row each. A terminal of
 * another hc client (no herdr.space label) or a finished one is left out. Throws TerminalListError on a shape it
 * cannot read, so a herdr-core protocol change shows up as an unreachable group instead of wrong rows.
 */
export function readTerminals(group: string, result: unknown): HcView {
  const parsed = ListResult.safeParse(result);
  if (!parsed.success) throw new TerminalListError(`terminal.list has an unexpected shape: ${z.prettifyError(parsed.error)}`);
  const size = new Map<string, { cols: number; rows: number }>();
  const rows = parsed.data.terminals
    .filter((t) => t.state === "live" && APP_LABEL in t.labels)
    .map((t): SourceSession => {
      size.set(t.address, { cols: t.cols, rows: t.rows });
      const app = t.status?.app ?? null;
      const agent = app === null ? null : (AGENTS[app] ?? app);
      const status = t.status && STATUSES.has(t.status.state) ? (t.status.state as AgentStatus) : "unknown";
      return {
        id: makeSessionId("hc", group, t.address),
        source: "hc",
        group,
        paneId: t.address,
        terminalId: t.address,
        // "where" is the app's "<space> / <tab>" label; a terminal the app adopted without it shows its folder.
        workspaceLabel: t.labels.where ?? basename(t.foreground?.cwd ?? t.cwd),
        title: t.title || null,
        cwd: t.foreground?.cwd ?? t.cwd,
        agent,
        claudeSessionId: null,
        // When the status word last changed: it moves exactly when herdr's state_change_seq would (spec 6.1).
        stateChangeSeq: t.status_ms ?? 0,
        reachable: true,
        status,
        ...(agent === "claude" && t.foreground ? { agentPid: t.foreground.pid } : {}),
      };
    });
  return { rows, size };
}
