import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

const DIR = process.env.SESSION_CONSOLE_DIR || join(homedir(), ".config", "session-console");
const TAILSCALE_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

/**
 * Every file under DIR has exactly one writer process; every other process only reads it. So the CLI and the
 * server never race on one file, and revocation is a timestamp marker per writer instead of an edit to tokens.json.
 * SESSION_CONSOLE_DIR replaces DIR, read once at import, so tests and local runs never touch the owner's state.
 */
export const PATHS = {
  dir: DIR,
  config: join(DIR, "config.json"), // writer: pnpm passphrase
  tokens: join(DIR, "tokens.json"), // writer: server. AuthSession[]
  revokedByCli: join(DIR, "revoked-by-cli"), // writer: pnpm passphrase, pnpm revoke-all
  revokedByServer: join(DIR, "revoked-by-server"), // writer: server, for "모든 기기 로그아웃"
  logins: join(DIR, "logins.jsonl"), // writer: server, append-only
  claudeDir: join(homedir(), ".claude"),
  claudeProjects: join(homedir(), ".claude", "projects"),
  webDist: new URL("../../web/dist/", import.meta.url).pathname,
  /** The Mac app's CLI (spec 4.5), else `tailscale` on PATH. */
  tailscale: existsSync(TAILSCALE_APP) ? TAILSCALE_APP : "tailscale",
} as const;

/** scrypt N=2^15, r=8, p=1 with a 16-byte salt (spec 10). salt and hash are base64. */
const ScryptHashSchema = z.object({
  algo: z.literal("scrypt"),
  N: z.literal(32768),
  r: z.literal(8),
  p: z.literal(1),
  keyLen: z.literal(64),
  salt: z.string(),
  hash: z.string(),
});
export type ScryptHash = z.infer<typeof ScryptHashSchema>;

export const ConfigSchema = z.object({
  version: z.literal(1),
  /** The Tailscale-User-Login that passes gate 1. */
  ownerLogin: z.string().min(1),
  /** e.g. https://macbookpro.tailfdccb7.ts.net. The only Origin accepted on POST routes and the WS upgrade. */
  publicOrigin: z.url(),
  /** Bound on 127.0.0.1 only. */
  port: z.number().int().min(1024).max(65535),
  herdrBin: z.string().min(1),
  passphrase: ScryptHashSchema,
});
export type ConsoleConfig = z.infer<typeof ConfigSchema>;

/** One JSON file with one writer process. */
export interface FileCell<T> {
  /** Stats the file and parses again only when mtime or size moved. A missing file reads as `empty`. Throws on corrupt content. */
  read(): T;
  /** For the file's single writer only. Writes `${path}.tmp-${pid}` with mode 0600 (PATHS.dir 0700), then renames. */
  write(value: T): Promise<void>;
}

export function fileCell<S extends z.ZodType>(path: string, schema: S, empty: z.output<S>): FileCell<z.output<S>> {
  // ino is part of the key: a rename by the writer swaps the inode even when size and mtime happen to match.
  let cached: { key: string; value: z.output<S> } | null = null;
  return {
    read() {
      const st = statSync(path, { bigint: true, throwIfNoEntry: false });
      if (!st) return empty;
      const key = `${st.ino}:${st.mtimeNs}:${st.size}`;
      if (cached?.key !== key) cached = { key, value: schema.parse(JSON.parse(readFileSync(path, "utf8"))) };
      return cached.value;
    },
    async write(value) {
      const dir = dirname(path);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
      const tmp = `${path}.tmp-${process.pid}`;
      // A temp file left by a crashed run keeps its old mode on rewrite, so it goes first.
      await rm(tmp, { force: true });
      await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
      await rename(tmp, path);
    },
  };
}

/** null until `pnpm passphrase` has run; the server refuses to start then, with a message naming that command. */
export function openConfig(): FileCell<ConsoleConfig | null> {
  return fileCell(PATHS.config, ConfigSchema.nullable(), null);
}

/** Read once at start. No flag skips gate 2, so a dev setting cannot open the data without the passphrase. */
export interface RuntimeFlags {
  /** CONSOLE_DEV_NO_TAILSCALE=1 skips gate 1 and drops Secure from the cookie (plain-HTTP dev). */
  devNoTailscale: boolean;
  /** CONSOLE_DEV_ORIGIN adds one allowed Origin (the Vite dev server). */
  devOrigin: string | null;
}

export function readFlags(env: NodeJS.ProcessEnv): RuntimeFlags {
  return { devNoTailscale: env.CONSOLE_DEV_NO_TAILSCALE === "1", devOrigin: env.CONSOLE_DEV_ORIGIN ?? null };
}
