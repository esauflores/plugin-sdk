// The only module that touches the filesystem. index.ts imports it lazily from
// PluginHost.load(), so the core runs without Node APIs when you only use register().

import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { isPlugin, PluginError, type Plugin, type PluginManifest } from "./types.ts";

/**
 * Finds an installed plugin package, checks its manifest, and imports its entry.
 * Doesn't use require.resolve / import.meta.resolve, which behave differently
 * across runtimes and with ESM-only packages.
 */
export async function loadPluginPackage(
  specifier: string,
  opts: { cwd: string; apiVersion: number; manifestKey: string },
): Promise<Plugin> {
  const fail = (message: string, cause?: unknown) =>
    new PluginError(specifier, "load", message, cause === undefined ? undefined : { cause });

  const dir = await findPackageDir(specifier, opts.cwd);
  if (!dir) throw fail(`package not found from ${opts.cwd} (is it installed?)`);

  let pkg: Record<string, any>;
  try {
    pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  } catch (error) {
    throw fail(`could not read ${join(dir, "package.json")}`, error);
  }

  const manifest: Partial<PluginManifest> | undefined = pkg[opts.manifestKey];
  if (!manifest || typeof manifest !== "object") {
    throw fail(`not a plugin: package.json has no "${opts.manifestKey}" field`);
  }

  if (manifest.apiVersion !== opts.apiVersion) {
    const declared = typeof manifest.apiVersion === "number" ? `v${manifest.apiVersion}` : "no version";
    throw fail(`targets plugin API ${declared}, but this host supports v${opts.apiVersion}`);
  }

  if (typeof manifest.entry !== "string") {
    throw fail(`manifest "${opts.manifestKey}" has no "entry" (e.g. "./dist/index.js")`);
  }

  const entry = resolve(dir, manifest.entry);

  let mod: Record<string, unknown>;
  try {
    mod = await import(pathToFileURL(entry).href);
  } catch (error) {
    throw fail(`failed to import ${entry}`, error);
  }

  const plugin = mod.default ?? mod.plugin;
  if (!isPlugin(plugin)) throw fail(`${entry} must export a plugin ({ name, setup }) as its default export`);

  return plugin;
}

async function findPackageDir(specifier: string, cwd: string): Promise<string | undefined> {
  if (specifier.startsWith(".") || isAbsolute(specifier)) {
    const dir = resolve(cwd, specifier);

    return (await isFile(join(dir, "package.json"))) ? dir : undefined;
  }

  // Same lookup Node does: node_modules in cwd, then each parent directory.
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", specifier);

    if (await isFile(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
