// `pnpm dev`: the Node server with gate 1 off (gate 2 stays) and Vite with HMR, both in the foreground.
// TODO spawn("node", ["--watch", "server/src/main.ts"], { env: { ...process.env, CONSOLE_DEV_NO_TAILSCALE: "1",
//        CONSOLE_DEV_ORIGIN: "http://localhost:5173" }, stdio: "inherit" }) and spawn("pnpm", ["exec", "vite", "web"]);
//      Ctrl+C kills both.
export {};
