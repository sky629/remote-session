#!/usr/bin/env node
// Stands in for the herdr CLI in adapter tests: `session list --json` prints FAKE_SESSIONS, and
// `terminal session observe` behaves like fake-observe.mjs.
const args = process.argv.slice(2);
if (args[0] === "session" && args[1] === "list") process.stdout.write(process.env.FAKE_SESSIONS ?? '{"sessions":[]}');
else if (args.includes("observe")) await import("./fake-observe.mjs");
else process.exit(2);
