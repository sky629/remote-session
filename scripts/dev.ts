// `pnpm dev`: the Node server with gate 1 off (gate 2 stays) and Vite with HMR, both in the foreground.
// Ctrl+C stops both, and either one exiting stops the other.
import { spawn } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const env = { ...process.env, CONSOLE_DEV_NO_TAILSCALE: "1", CONSOLE_DEV_ORIGIN: "http://localhost:5173" };
const children = [
  spawn(process.execPath, ["--watch", "server/src/main.ts"], { cwd: root, env, stdio: "inherit" }),
  spawn("pnpm", ["exec", "vite", "web"], { cwd: root, stdio: "inherit" }),
];

const stop = () => {
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, stop);
for (const child of children) {
  child.on("exit", (code) => {
    process.exitCode ||= code ?? 0;
    stop();
  });
}
