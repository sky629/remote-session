import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";

/**
 * A server module is a first-level entry of server/src: a file, or a folder whose public file is index.ts.
 * Relative imports stay inside one module; crossing modules goes through a package.json `imports` alias, and each
 * alias names a public file. So a copied relative path into another module's internals fails here, and the alias
 * map offers no way in.
 */
const repo = resolve(import.meta.dirname, "../..");
const server = join(repo, "server/src");
const aliases = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).imports as Record<string, string>;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
const sources = (dir: string) => walk(dir).filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".test.ts"));
const specifiers = (file: string) =>
  [...readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((m) => m[1]!);
const moduleOf = (file: string) => relative(server, file).split(sep)[0]!;
const where = (file: string) => relative(repo, file);

test("every alias points at an existing public file", () => {
  for (const [alias, target] of Object.entries(aliases)) {
    if (alias.endsWith("/*")) continue;
    assert.ok(existsSync(join(repo, target)), `${alias} → ${target} does not exist`);
  }
});

test("no relative import in server/src crosses a module boundary", () => {
  for (const file of sources(server)) {
    for (const spec of specifiers(file).filter((s) => s.startsWith("."))) {
      const target = resolve(dirname(file), spec);
      assert.equal(moduleOf(target), moduleOf(file), `${where(file)} imports ${spec}; use the # alias`);
    }
  }
});

test("shared imports nothing outside shared", () => {
  for (const file of sources(join(repo, "shared"))) {
    for (const spec of specifiers(file)) {
      assert.ok(!spec.startsWith("#") && !spec.startsWith(".."), `${where(file)} imports ${spec}`);
    }
  }
});

test("web reaches shared only through #shared and never reaches the server", () => {
  for (const file of sources(join(repo, "web/src"))) {
    for (const spec of specifiers(file)) {
      const target = spec.startsWith(".") ? relative(join(repo, "web/src"), resolve(dirname(file), spec)) : "";
      assert.ok(!target.startsWith(".."), `${where(file)} imports ${spec} outside web/src; use #shared/*`);
      assert.ok(!spec.startsWith("#") || spec.startsWith("#shared/"), `${where(file)} imports server module ${spec}`);
    }
  }
});
