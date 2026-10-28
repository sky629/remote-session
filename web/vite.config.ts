import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// Dev only: Vite on :5173 proxies API and WS to the Node server started by scripts/dev.ts.
// The server allows this origin through CONSOLE_DEV_ORIGIN; gate 2 (passphrase) still applies.
// CONSOLE_SERVER points the proxy somewhere else, such as web/mock/server.mjs.
const upstream = process.env.CONSOLE_SERVER ?? "127.0.0.1:7420";

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  plugins: [preact()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/api": `http://${upstream}`,
      "/ws": { target: `ws://${upstream}`, ws: true },
    },
  },
});
