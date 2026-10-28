import { createAuth } from "#auth";
import { createTranscripts } from "#claude";
import { openConfig, PATHS, readFlags } from "#config";
import { createHerdrSource } from "#herdr";
import { createHttpServer } from "#http";
import { createHub } from "#hub";
import { createSessionRegistry } from "#sessions";
import type { SessionSource, SourceTable } from "#source";

// Composition root. Adding cmux is one entry in `sources`; nothing else in the server or web changes.
const configFile = openConfig();
const config = configFile.read();
if (!config) throw new Error("암호가 아직 없습니다. 먼저 `pnpm passphrase`를 실행하세요.");
const flags = readFlags(process.env);

const auth = createAuth({ config: configFile, flags });
const transcripts = createTranscripts(PATHS.claudeProjects);
const sources: SourceTable = {
  herdr: createHerdrSource({ herdrBin: config.herdrBin, callTimeoutMs: 3000, relistMs: 60_000 }),
};
const registry = createSessionRegistry({
  sources: Object.values(sources).filter((s): s is SessionSource => s !== undefined),
  transcripts,
  intervalMs: 1500,
});
const hub = createHub({ registry, transcripts, sources, auth });
const server = createHttpServer({ auth, registry, transcripts, sources, hub, staticDir: PATHS.webDist });
server.listen(config.port, "127.0.0.1");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    server.close();
    hub.close();
    await Promise.all(Object.values(sources).map((s) => s?.close()));
    process.exit(0);
  });
}
