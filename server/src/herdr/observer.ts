import type { TerminalFrame } from "#shared/domain";
import type { TerminalSink } from "#source";
import { createObservation as observe } from "#observer";
import type { Observation, ObserverDriver } from "#observer";

export interface ObserverSpec {
  group: string;
  terminalId: string;
  cols: number;
  rows: number;
}

export type HerdrObservation = Observation;

/**
 * `herdr --session <g> terminal session observe <t> --cols W --rows H` prints one JSON record per line: frames,
 * and terminal.closed for an unknown terminal (it then exits 0; measured). The child is restarted by the generic
 * observer; see server/src/observer.ts for the lifecycle.
 */
export function herdrDriver(herdrBin: string): ObserverDriver<ObserverSpec> {
  return {
    command: (s) => ({ bin: herdrBin, args: ["--session", s.group, "terminal", "session", "observe", s.terminalId, "--cols", `${s.cols}`, "--rows", `${s.rows}`] }),
    reader() {
      let rest = Buffer.alloc(0);
      return (chunk) => {
        rest = Buffer.concat([rest, chunk]);
        const records: (TerminalFrame | "closed")[] = [];
        for (let nl = rest.indexOf(0x0a); nl >= 0; nl = rest.indexOf(0x0a)) {
          const record = readRecord(rest.subarray(0, nl).toString("utf8"));
          rest = rest.subarray(nl + 1);
          if (record) records.push(record);
          if (record === "closed") break;
        }
        return records;
      };
    },
    same: (a, b) => a.group === b.group && a.terminalId === b.terminalId && a.cols === b.cols && a.rows === b.rows,
  };
}

export function createObservation(herdrBin: string, spec: () => ObserverSpec | null, sink: TerminalSink, onEnd: () => void): HerdrObservation {
  return observe(herdrDriver(herdrBin), spec, sink, onEnd);
}

/** The boundary check on herdr's output: a frame, the end marker, or null for anything else. */
function readRecord(line: string): TerminalFrame | "closed" | null {
  let r: unknown;
  try {
    r = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof r !== "object" || r === null) return null;
  const { type, seq, full, width, height, bytes } = r as Record<string, unknown>;
  if (type === "terminal.closed") return "closed";
  if (type !== "terminal.frame") return null;
  if (typeof seq !== "number" || typeof full !== "boolean" || typeof width !== "number" || typeof height !== "number" || typeof bytes !== "string") return null;
  return { seq, full, width, height, bytes };
}
