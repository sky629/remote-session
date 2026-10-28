import { hashPassphrase, revokeAll } from "#auth";
import { openConfig } from "#config";

/**
 * `pnpm passphrase`. Not `setup`: pnpm 11 runs its built-in `pnpm setup` and never reaches a script of that name.
 * Safe to run twice; the second run replaces the hash and moves the revoke marker again.
 */
async function main(): Promise<void> {
  // TODO
  //   1. config = openConfig().read(), or defaults from `tailscale status --json`:
  //        ownerLogin = User[Self.UserID].LoginName, publicOrigin = `https://${Self.DNSName without the trailing dot}`,
  //        port 7420, herdrBin "herdr"; print them and let Enter accept them
  //   2. read the passphrase twice with echo off; under 8 characters refuse, under 12 warn
  //   3. openConfig().write({ ...config, passphrase: await hashPassphrase(p) })   (this CLI is the only writer of config.json)
  //   4. removed = await revokeAll(); print "기존 로그인 N개를 모두 무효로 했습니다."
  throw new Error("not implemented");
}
await main();
