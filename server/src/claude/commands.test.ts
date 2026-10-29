import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BUILTIN, createCommandCatalog, frontmatter } from "./commands.ts";

// A made-up ~/.claude and project: nothing here is read from the real home directory.
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "sc-commands-"));
  const skill = (root: string, name: string, desc: string) => {
    mkdirSync(join(root, "skills", name), { recursive: true });
    writeFileSync(join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\nbody\n`);
  };
  skill(dir, "make-pr", '"Draft a PR, \\"honestly\\""');
  mkdirSync(join(dir, "skills", ".trash", "old"), { recursive: true });
  writeFileSync(join(dir, "skills", ".trash", "old", "SKILL.md"), "---\nname: old\n---\n");
  mkdirSync(join(dir, "skills", "synced", "uuid-1"), { recursive: true });
  mkdirSync(join(dir, "commands", "git"), { recursive: true });
  writeFileSync(join(dir, "commands", "git", "fixup.md"), "---\ndescription: >\n  Squash fixups\n  into their targets\n---\nDo it\n");
  writeFileSync(join(dir, "commands", "notes.txt"), "not a command");
  const elsewhere = mkdtempSync(join(tmpdir(), "sc-linked-"));
  skill(elsewhere, "ego-browser", "Browser via a symlinked skill");
  symlinkSync(join(elsewhere, "skills", "ego-browser"), join(dir, "skills", "ego-browser"));

  const plugins = join(dir, "plugins");
  const pstack = join(plugins, "cache", "m", "pstack", "1.0.0");
  const off = join(plugins, "cache", "m", "off", "1.0.0");
  skill(pstack, "poteto-mode", "Poteto playbooks");
  mkdirSync(join(pstack, "commands"), { recursive: true });
  writeFileSync(join(pstack, "commands", "help.md"), "---\ndescription: pstack help\n---\n");
  skill(off, "hidden", "disabled plugin");
  mkdirSync(plugins, { recursive: true });
  writeFileSync(join(plugins, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "pstack@m": [{ installPath: pstack }], "off@m": [{ installPath: off }], "gone@m": [{ installPath: join(plugins, "nope") }] } }));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ enabledPlugins: { "pstack@m": true, "off@m": false } }));
  return dir;
}

test("list: user, project, plugin and built-in commands, named as Claude Code invokes them", async () => {
  const dir = home();
  const project = mkdtempSync(join(tmpdir(), "sc-project-"));
  mkdirSync(join(project, ".claude", "skills", "review-pr"), { recursive: true });
  writeFileSync(join(project, ".claude", "skills", "review-pr", "SKILL.md"), "---\ndescription: 'It''s the repo reviewer'\n---\n");
  const all = await createCommandCatalog(dir).list(project);
  const byName = Object.fromEntries(all.map((c) => [c.name, c]));
  assert.deepEqual(byName["make-pr"], { name: "make-pr", description: 'Draft a PR, "honestly"', source: "user" });
  assert.deepEqual(byName["ego-browser"], { name: "ego-browser", description: "Browser via a symlinked skill", source: "user" }, "a symlinked skill dir counts");
  assert.deepEqual(byName["fixup"], { name: "fixup", description: "", source: "user" }, "a command in a subfolder keeps its file name; a folded description has no first line");
  assert.deepEqual(byName["review-pr"], { name: "review-pr", description: "It's the repo reviewer", source: "project" });
  assert.deepEqual(byName["pstack:poteto-mode"], { name: "pstack:poteto-mode", description: "Poteto playbooks", source: "plugin" });
  assert.deepEqual(byName["pstack:help"], { name: "pstack:help", description: "pstack help", source: "plugin" });
  assert.equal(byName["help"]?.source, "builtin", "the plugin's help does not shadow the built-in: names differ");
  assert.equal(byName["off:hidden"], undefined, "a disabled plugin is hidden");
  assert.equal(byName["old"], undefined, "dot directories are skipped");
  assert.equal(byName["notes"], undefined, "only .md files are commands");
  assert.equal(all.length, 6 + BUILTIN.length);
  assert.deepEqual(all.map((c) => c.name), [...all.map((c) => c.name)].sort((a, b) => a.localeCompare(b)), "sorted by name");
});

test("list: a project skill with a built-in's name wins, and a missing cwd or home gives just the built-ins", async () => {
  const dir = home();
  const project = mkdtempSync(join(tmpdir(), "sc-project-"));
  mkdirSync(join(project, ".claude", "skills", "review"), { recursive: true });
  writeFileSync(join(project, ".claude", "skills", "review", "SKILL.md"), "---\ndescription: ours\n---\n");
  const all = await createCommandCatalog(dir).list(project);
  assert.deepEqual(all.find((c) => c.name === "review"), { name: "review", description: "ours", source: "project" });
  assert.deepEqual(await createCommandCatalog(join(dir, "missing")).list(null), [...BUILTIN].sort((a, b) => a.name.localeCompare(b.name)));
});

test("frontmatter: fences, quoting, and a body that is not frontmatter", () => {
  assert.deepEqual(frontmatter('---\nname: x\ndescription: "a \\"b\\" c"\nflag: true\n---\n# body\nkey: not read\n'), { name: "x", description: 'a "b" c', flag: "true" });
  assert.deepEqual(frontmatter("# no frontmatter\nname: y\n"), {});
  assert.deepEqual(frontmatter("---\ndescription: |\n  two\n  lines\n---\n"), { description: "" });
});
