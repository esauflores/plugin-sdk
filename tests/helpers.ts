import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Logger } from "@/index.ts";

export const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export const app = { name: "testapp", version: "1.4.0" };

/** Creates a temp project whose node_modules contains the given packages: { "pkg-name": { "file.js": "...", "package.json": {...} } }. */
export async function makeProject(packages: Record<string, Record<string, string | object>>) {
  const root = await mkdtemp(join(tmpdir(), "plugin-sdk-"));
  for (const [name, files] of Object.entries(packages)) {
    for (const [file, content] of Object.entries(files)) {
      const path = join(root, "node_modules", name, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, typeof content === "string" ? content : JSON.stringify(content, null, 2));
    }
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** A minimal npm-style plugin package with the testapp manifest. */
export function pluginPackage(name: string, source: string, pkg: Record<string, unknown> = {}) {
  return {
    "package.json": { name, version: "1.0.0", type: "module", testapp: { apiVersion: 1, entry: "./index.js" }, ...pkg },
    "index.js": source,
  };
}
