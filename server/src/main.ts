import { createAuth } from "#auth";
import { createCommandCatalog, createTranscripts } from "#claude";
import { openConfig, PATHS, readFlags } from "#config";
import { createHerdrSource } from "#herdr";
import { createHttpServer } from "#http";
import { createHub } from "#hub";
import { createSessionRegistry } from "#sessions";
import type { SessionSource, SourceTable } from "#source";

// Composition root. Adding cmux is one entry in `sources`; nothing else in the server or web changes.
const configFile = openConfig();
const config = configFile.read();
if (!config) {
  console.error(`암호가 아직 없습니다. 먼저 \`pnpm passphrase\`를 실행하세요. (설정 파일: ${PATHS.config})`);
  process.exit(1);
}
const flags = readFlags(process.env);

const auth = createAuth({ config: configFile, flags });
const transcripts = createTranscripts(PATHS.claudeProjects);
const commands = createCommandCatalog(PATHS.claudeDir);
const sources: SourceTable = {
  herdr: createHerdrSource({ herdrBin: config.herdrBin, callTimeoutMs: 3000, relistMs: 60_000 }),
};
const registry = createSessionRegistry({
  sources: Object.values(sources).filter((s): s is SessionSource => s !== undefined),
  transcripts,
  intervalMs: 1500,
});
const hub = createHub({ registry, transcripts, sources, auth });
const server = createHttpServer({ auth, registry, transcripts, commands, sources, hub, staticDir: PATHS.webDist, config: configFile, flags });
server.on("error", (e: NodeJS.ErrnoException) => {
  console.error(e.code === "EADDRINUSE" ? `포트 ${config.port}를 이미 다른 프로세스가 쓰고 있습니다.` : `서버를 시작하지 못했습니다: ${e.message}`);
  process.exit(1);
});
server.listen(config.port, "127.0.0.1", () => {
  console.log(`세션 콘솔이 http://127.0.0.1:${config.port} 에서 실행 중입니다. 상태 디렉터리는 ${PATHS.dir}입니다.`);
  if (flags.devNoTailscale) console.log("개발 모드라서 1차 관문(Tailscale)이 꺼져 있습니다. 로그인 암호 관문은 그대로 동작합니다.");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    server.close();
    hub.close();
    await Promise.all(Object.values(sources).map((s) => s?.close()));
    process.exit(0);
  });
}
