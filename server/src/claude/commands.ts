import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SlashCommand } from "#shared/domain";

/**
 * The slash commands Claude Code accepts in a session's input, read from the same places Claude Code reads them:
 *   user     ~/.claude/skills/<name>/SKILL.md, ~/.claude/commands/**\/<name>.md
 *   project  <cwd>/.claude/skills/<name>/SKILL.md, <cwd>/.claude/commands/**\/<name>.md
 *   plugin   <installPath>/skills/<name>/SKILL.md and commands/**\/<name>.md of every enabled plugin, as plugin:name
 *   builtin  BUILTIN, the commands Claude Code itself provides; the disk cannot tell us these
 * The invocation name is the directory or file name, as Claude Code uses it; the description comes from frontmatter.
 */
export interface CommandCatalog {
  /** Sorted by name; the first of a repeated name wins in the order project, user, plugin, builtin. Never rejects. */
  list(cwd: string | null): Promise<SlashCommand[]>;
}

export const BUILTIN: readonly SlashCommand[] = [
  ["help", "명령과 단축키 안내"],
  ["clear", "대화 기록 비우기"],
  ["compact", "대화 요약으로 컨텍스트 줄이기"],
  ["config", "설정 열기"],
  ["cost", "이 세션의 비용 보기"],
  ["context", "컨텍스트 사용량 보기"],
  ["model", "모델 바꾸기"],
  ["effort", "추론 노력 수준 바꾸기"],
  ["fast", "빠른 모드 켜고 끄기"],
  ["memory", "메모리 파일 열기"],
  ["permissions", "권한 규칙 보기와 편집"],
  ["mcp", "MCP 서버 상태"],
  ["agents", "에이전트 관리"],
  ["plugin", "플러그인 관리"],
  ["status", "세션 상태 보기"],
  ["resume", "이전 대화 이어서 하기"],
  ["review", "코드 리뷰 요청"],
  ["init", "CLAUDE.md 만들기"],
  ["doctor", "설치 상태 진단"],
  ["exit", "Claude Code 끝내기"],
].map(([name, description]) => ({ name: name!, description: description!, source: "builtin" as const }));

export function createCommandCatalog(claudeDir: string): CommandCatalog {
  return {
    async list(cwd) {
      const found = await Promise.all([
        cwd ? scanRoot(join(cwd, ".claude"), "project", "") : [],
        scanRoot(claudeDir, "user", ""),
        pluginRoots(claudeDir).then((roots) => Promise.all(roots.map(({ plugin, path }) => scanRoot(path, "plugin", `${plugin}:`)))).then((r) => r.flat()),
      ]);
      const byName = new Map<string, SlashCommand>();
      for (const c of [...found.flat(), ...BUILTIN]) if (!byName.has(c.name)) byName.set(c.name, c);
      return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}

/** `<root>/skills/*\/SKILL.md` and `<root>/commands/**\/*.md`, named `${prefix}${name}`. A missing root gives []. */
async function scanRoot(root: string, source: SlashCommand["source"], prefix: string): Promise<SlashCommand[]> {
  const [skills, commands] = await Promise.all([skillDirs(join(root, "skills")), markdownFiles(join(root, "commands"))]);
  return Promise.all([
    ...skills.map(async ({ name, file }) => ({ name: `${prefix}${name}`, description: await description(file), source })),
    ...commands.map(async ({ name, file }) => ({ name: `${prefix}${name}`, description: await description(file), source })),
  ]);
}

/** Directories (symlinks followed) that hold a SKILL.md; dot directories are skipped, as Claude Code skips them. */
async function skillDirs(dir: string): Promise<{ name: string; file: string }[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const hits = await Promise.all(
    names
      .filter((n) => !n.startsWith("."))
      .map(async (name) => {
        const file = join(dir, name, "SKILL.md");
        return (await isFile(file)) ? [{ name, file }] : [];
      }),
  );
  return hits.flat();
}

/** Every *.md under dir, recursively; the name is the file name without .md, as Claude Code names commands. */
async function markdownFiles(dir: string): Promise<{ name: string; file: string }[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const hits = await Promise.all(
    entries.map(async (e) => {
      if (e.name.startsWith(".")) return [];
      const path = join(dir, e.name);
      if (e.isDirectory()) return markdownFiles(path);
      return e.name.endsWith(".md") && (e.isFile() || (e.isSymbolicLink() && (await isFile(path)))) ? [{ name: e.name.slice(0, -3), file: path }] : [];
    }),
  );
  return hits.flat();
}

/**
 * Installed plugins that settings.json does not disable: plugins/installed_plugins.json gives each `name@market`
 * its installPath, and enabledPlugins[name@market] === false hides it. Unreadable files give [].
 */
async function pluginRoots(claudeDir: string): Promise<{ plugin: string; path: string }[]> {
  const installed = await readJson(join(claudeDir, "plugins", "installed_plugins.json"));
  const settings = await readJson(join(claudeDir, "settings.json"));
  const enabled = isRecord(settings?.enabledPlugins) ? settings.enabledPlugins : {};
  const plugins = isRecord(installed?.plugins) ? installed.plugins : {};
  const roots: { plugin: string; path: string }[] = [];
  for (const [key, entries] of Object.entries(plugins)) {
    if (enabled[key] === false || !Array.isArray(entries)) continue;
    const first = entries[0];
    const path = isRecord(first) && typeof first.installPath === "string" ? first.installPath : null;
    if (path) roots.push({ plugin: key.split("@")[0]!, path });
  }
  return roots;
}

/** The frontmatter `description` of a skill or command file, first line only, unquoted; "" when absent. */
async function description(file: string): Promise<string> {
  const text = await readFile(file, "utf8").catch(() => "");
  return frontmatter(text).description ?? "";
}

/** Single-line `key: value` pairs between the leading `---` fences. A folded or multi-line value keeps its first line. */
export function frontmatter(text: string): Record<string, string> {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  const out: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") break;
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    if (value === ">" || value === "|" || value === ">-" || value === "|-") value = "";
    else if (/^".*"$/.test(value)) value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    else if (/^'.*'$/.test(value)) value = value.slice(1, -1).replace(/''/g, "'");
    out[m[1]!] = value;
  }
  return out;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isFile(),
    () => false,
  );
}
