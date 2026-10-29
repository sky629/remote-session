import { z } from "zod";
import { makeSessionId, parseClaudeSessionId } from "#shared/domain";
import type { AgentStatus } from "#shared/domain";
import type { SourceSession } from "#source";

export interface HerdrView {
  rows: SourceSession[];
  /** Pane size from layouts[].panes[].rect, keyed by terminal id. Observers open at exactly this size (spec 4.2). */
  size: ReadonlyMap<string, { cols: number; rows: number }>;
}

export class SnapshotError extends Error {}

const optionalText = z.string().nullish();
const Snapshot = z.object({
  panes: z.array(
    z.object({
      pane_id: z.string(),
      terminal_id: z.string(),
      workspace_id: z.string(),
      terminal_title_stripped: optionalText,
      cwd: optionalText,
      foreground_cwd: optionalText,
    }),
  ),
  agents: z.array(
    z.object({
      pane_id: z.string(),
      agent: z.string(),
      agent_status: z.string(),
      state_change_seq: z.number().int(),
      agent_session: z.object({ kind: z.string(), value: z.unknown() }).nullish(),
    }),
  ),
  workspaces: z.array(z.object({ workspace_id: z.string(), label: z.string() })),
  layouts: z.array(
    z.object({
      panes: z.array(z.object({ pane_id: z.string(), rect: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }) })),
    }),
  ),
});

const STATUSES = new Set<string>(["idle", "working", "blocked", "done", "unknown"] satisfies AgentStatus[]);

/**
 * Joins one `session.snapshot` result into rows. panes[] gives one row per pane, agent or not. agents[] by pane_id
 * adds agent, agent_session and state_change_seq. workspaces[] by workspace_id adds the label. layouts[].panes[]
 * by pane_id adds the rect. Throws SnapshotError on a shape it cannot read, so a herdr protocol change shows up as
 * an unreachable group instead of wrong rows. A status herdr adds later reads as "unknown" rather than failing.
 */
export function readSnapshot(group: string, result: unknown): HerdrView {
  const parsed = Snapshot.safeParse(result);
  if (!parsed.success) throw new SnapshotError(`session.snapshot has an unexpected shape: ${z.prettifyError(parsed.error)}`);
  const { panes, agents, workspaces, layouts } = parsed.data;
  const agentOf = new Map(agents.map((a) => [a.pane_id, a]));
  const labelOf = new Map(workspaces.map((w) => [w.workspace_id, w.label]));
  const rectOf = new Map(layouts.flatMap((l) => l.panes.map((p) => [p.pane_id, p.rect] as const)));

  const size = new Map<string, { cols: number; rows: number }>();
  const rows = panes.map((pane): SourceSession => {
    const rec = agentOf.get(pane.pane_id);
    const rect = rectOf.get(pane.pane_id);
    if (rect) size.set(pane.terminal_id, { cols: rect.width, rows: rect.height });
    const status = rec && STATUSES.has(rec.agent_status) ? (rec.agent_status as AgentStatus) : "unknown";
    return {
      id: makeSessionId("herdr", group, pane.pane_id),
      source: "herdr",
      group,
      paneId: pane.pane_id,
      terminalId: pane.terminal_id,
      workspaceLabel: labelOf.get(pane.workspace_id) ?? pane.workspace_id,
      title: pane.terminal_title_stripped || null,
      cwd: pane.foreground_cwd ?? pane.cwd ?? null,
      agent: rec?.agent ?? null,
      claudeSessionId: rec?.agent === "claude" && rec.agent_session?.kind === "id" ? parseClaudeSessionId(rec.agent_session.value) : null,
      stateChangeSeq: rec?.state_change_seq ?? 0,
      reachable: true,
      status,
    };
  });
  return { rows, size };
}
