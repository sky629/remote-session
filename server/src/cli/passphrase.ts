import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import { hashPassphrase, revokeAll } from "#auth";
import { ConfigSchema, openConfig, PATHS } from "#config";
import type { ConsoleConfig } from "#config";

type Settings = Omit<ConsoleConfig, "version" | "passphrase">;

/**
 * `pnpm passphrase`. Not `setup`: pnpm 11 runs its built-in `pnpm setup` and never reaches a script of that name.
 * Safe to run twice; the second run replaces the hash and moves the revoke marker again.
 */
async function main(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error("암호를 화면에 보이지 않게 받아야 하므로 터미널에서 직접 실행하세요.");
    process.exit(1);
  }
  const cell = openConfig();
  const current = cell.read();
  const defaults: Settings = current ?? { ...(await tailscaleDefaults()), port: 7420, herdrBin: "herdr" };

  console.log(`설정 파일은 ${PATHS.config}입니다. Enter를 누르면 [ ] 안의 값을 그대로 씁니다.`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (label: string, value: string) => (await rl.question(`${label} [${value}]: `)).trim() || value;
  const settings = {
    ownerLogin: await ask("소유자 Tailscale 계정", defaults.ownerLogin),
    publicOrigin: await ask("공개 주소", defaults.publicOrigin),
    port: Number(await ask("포트", String(defaults.port))),
    herdrBin: await ask("herdr 실행 파일", defaults.herdrBin),
  };
  rl.close();

  let passphrase: string;
  for (;;) {
    passphrase = await readHidden("새 암호: ");
    if ([...passphrase].length < 8) {
      console.log("암호는 8자 이상이어야 합니다. 다시 입력하세요.");
      continue;
    }
    if ((await readHidden("한 번 더 입력하세요: ")) !== passphrase) {
      console.log("두 암호가 다릅니다. 처음부터 다시 입력하세요.");
      continue;
    }
    break;
  }
  if ([...passphrase].length < 12) console.log("12자 이상의 암호를 권장합니다. 이 암호로 계속 진행합니다.");

  const parsed = ConfigSchema.safeParse({ version: 1, ...settings, passphrase: await hashPassphrase(passphrase) });
  if (!parsed.success) {
    console.error("설정 값이 올바르지 않아 저장하지 않았습니다.");
    for (const issue of parsed.error.issues) console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    process.exit(1);
  }
  await cell.write(parsed.data);
  const removed = await revokeAll();
  console.log(`암호를 저장했습니다. 기존 로그인 ${removed.length}개를 모두 무효로 했습니다.`);
}

/** ownerLogin and publicOrigin from `tailscale status --json`; empty strings when Tailscale cannot answer. */
async function tailscaleDefaults(): Promise<Pick<Settings, "ownerLogin" | "publicOrigin">> {
  try {
    const { stdout } = await promisify(execFile)(PATHS.tailscale, ["status", "--json"], { timeout: 5000 });
    const status = JSON.parse(stdout) as { Self?: { UserID?: number; DNSName?: string }; User?: Record<string, { LoginName?: string }> };
    const login = status.User?.[String(status.Self?.UserID)]?.LoginName ?? "";
    const host = (status.Self?.DNSName ?? "").replace(/\.$/, "");
    return { ownerLogin: login, publicOrigin: host ? `https://${host}` : "" };
  } catch {
    console.log("tailscale status를 읽지 못해서 기본값 없이 묻습니다.");
    return { ownerLogin: "", publicOrigin: "" };
  }
}

/** One line from the terminal with echo off. Ctrl+C quits without writing anything. */
function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let value = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          finish();
          return resolve(value);
        }
        if (ch === "\u0003") {
          finish();
          console.log("취소했습니다. 아무것도 바꾸지 않았습니다.");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") value = [...value].slice(0, -1).join("");
        else if (ch >= " ") value += ch;
      }
    };
    process.stdout.write(prompt);
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

await main();
