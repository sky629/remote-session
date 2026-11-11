#!/usr/bin/env node
// Stands in for `hc attach --observe <t>` in observer tests: raw terminal bytes on stdout, no framing.
// FAKE_MODE: "hang" (a repaint, then a second chunk 50 ms later, then waits), "exit" (a repaint, then exits 0 like a
// finished terminal). Every start is appended to FAKE_LOG.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ event: "start", args, pid: process.pid })}\n`);
process.on("SIGTERM", () => process.exit(0));
const repaint = "\x18\x1b[!p\x1b[H\x1b[2Jscreen one";

switch (process.env.FAKE_MODE) {
  case "hang":
    process.stdout.write(repaint);
    setTimeout(() => process.stdout.write("\r\nmore"), 50);
    setInterval(() => {}, 1000);
    break;
  case "exit":
    process.stdout.write(repaint, () => {
      process.stderr.write("[t1n finished: killed]\n");
      process.exit(0);
    });
    break;
}
