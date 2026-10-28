import { makeSessionId, parseClaudeSessionId } from "#shared/domain";
import type { SourceSession } from "#source";

export interface HerdrView {
  rows: SourceSession[];
  /** Pane size from layouts[].panes[].rect, keyed by terminal id. Observers open at exactly this size (spec 4.2). */
  size: ReadonlyMap<string, { cols: number; rows: number }>;
}

export class SnapshotError extends Error {}

/**
 * Joins one `session.snapshot` result into rows. panes[] gives one row per pane, agent or not. agents[] by pane_id
 * adds agent, agent_session and state_change_seq. workspaces[] by workspace_id adds the label. layouts[].panes[]
 * by pane_id adds the rect. Throws SnapshotError on a shape it cannot read, so a herdr protocol change shows up as
 * an unreachable group instead of wrong rows.
 */
export function readSnapshot(group: string, result: unknown): HerdrView {
  // TODO mapping (field names measured on herdr 0.9.5, protocol 22):
  //   id = makeSessionId("herdr", group, pane.pane_id)     terminalId = pane.terminal_id
  //   workspaceLabel = workspace.label                     title = pane.terminal_title_stripped || null
  //   cwd = pane.foreground_cwd ?? pane.cwd ?? null        agent = agentRec?.agent ?? null
  //   status = agent ? agentRec.agent_status : "unknown"   stateChangeSeq = agentRec?.state_change_seq ?? 0
  //   claudeSessionId = agent === "claude" && agentRec.agent_session?.kind === "id" ? parseClaudeSessionId(value) : null
  //   reachable = true
  // Test against the captured snapshot.json: 7 rows, w12:p1 has agent null, every rect is 155x54.
  throw new Error("not implemented");
}
