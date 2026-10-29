#!/usr/bin/env node
// Stands in for `herdr --session <g> terminal session observe <t> --cols W --rows H` in observer tests.
// FAKE_MODE: "hang" (one full frame, then waits), "exit" (two frames, then exits), "crash" (exits 1 at once),
// "closed" (one frame, then terminal.closed, then waits). Every start and SIGTERM is appended to FAKE_LOG.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const log = (event) => appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ ...event, pid: process.pid, at: Date.now() })}\n`);
const cols = Number(args[args.indexOf("--cols") + 1]);
const rows = Number(args[args.indexOf("--rows") + 1]);
const frame = (seq, full) =>
  JSON.stringify({ type: "terminal.frame", seq, full, width: cols, height: rows, encoding: "ansi", bytes: Buffer.from(`screen ${seq}`).toString("base64") }) + "\n";

log({ event: "start", args });
process.on("SIGTERM", () => {
  log({ event: "sigterm" });
  process.exit(0);
});
const wait = () => setInterval(() => {}, 1000);

switch (process.env.FAKE_MODE) {
  case "hang":
    process.stdout.write(frame(1, true));
    wait();
    break;
  case "exit":
    process.stdout.write(frame(1, true) + frame(2, false), () => process.exit(0));
    break;
  case "crash":
    process.exit(1);
    break;
  case "closed":
    process.stdout.write(frame(1, true) + `${JSON.stringify({ type: "terminal.closed", reason: "gone" })}\n`);
    wait();
    break;
}
