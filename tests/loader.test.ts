import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, test } from "vitest";

import { PluginHost } from "@/index.ts";

import { app, makeProject, pluginPackage, silent } from "./helpers.ts";

const cleanups: Array<() => Promise<void>> = [];
afterAll(() => Promise.all(cleanups.map((c) => c())));

async function project(packages: Parameters<typeof makeProject>[0]) {
  const p = await makeProject(packages);
  cleanups.push(p.cleanup);
  return p.root;
}

const host = (failure: "isolate" | "strict" = "isolate") => new PluginHost({ app, logger: silent, failure });

describe("loading npm-style packages", () => {
  test("resolves from node_modules in a parent directory and passes options", async () => {
    const root = await project({
      "testapp-plugin-hello": pluginPackage(
        "testapp-plugin-hello",
        `export default { name: "hello", setup(ctx) { ctx.provide("greeting", "hi " + ctx.options.who); } };`,
      ),
    });
    const nested = join(root, "src", "deep");
    await mkdir(nested, { recursive: true });

    const h = await host().load([["testapp-plugin-hello", { who: "bob" }]], { cwd: nested });
    await h.start();
    assert.equal(h.service("greeting"), "hi bob");
    assert.equal(h.get("hello")!.source, "testapp-plugin-hello");
  });

  test("loads scoped packages and plugins that depend on each other", async () => {
    const root = await project({
      "@acme/testapp-db": pluginPackage(
        "@acme/testapp-db",
        `export default { name: "db", setup: (ctx) => ctx.provide("db", 7) };`,
      ),
      "testapp-api": pluginPackage(
        "testapp-api",
        `export const plugin = { name: "api", dependsOn: ["db"], setup: (ctx) => ctx.provide("api", ctx.use("db") * 6) };`,
      ),
    });
    // Listed in the "wrong" order on purpose: dependsOn decides the order, not the list.
    const h = await host().load(["testapp-api", "@acme/testapp-db"], { cwd: root });
    await h.start();
    assert.equal(h.service("api"), 42);
  });

  test("loads a plugin from a relative path", async () => {
    const root = await project({ local: pluginPackage("local", `export default { name: "local", setup() {} };`) });
    const h = await host().load(["./node_modules/local"], { cwd: root });
    assert.equal(h.get("local")!.state, "registered");
  });

  test("records packages that can't be loaded as failed, without stopping the others", async () => {
    const root = await project({
      "not-a-plugin": { "package.json": { name: "not-a-plugin" }, "index.js": "" },
      "old-api": pluginPackage("old-api", `export default { name: "old", setup() {} };`, {
        testapp: { apiVersion: 0 },
      }),
      "no-entry": pluginPackage("no-entry", `export default { name: "ne", setup() {} };`, {
        testapp: { apiVersion: 1 },
      }),
      "bad-export": pluginPackage("bad-export", `export default { name: "x" };`),
      throws: pluginPackage("throws", `throw new Error("import-time crash");`),
      fine: pluginPackage("fine", `export default { name: "fine", setup() {} };`),
    });
    const h = await host().load(["not-a-plugin", "old-api", "no-entry", "bad-export", "throws", "missing", "fine"], {
      cwd: root,
    });
    await h.start();

    const reasons = Object.fromEntries(h.list().map((p) => [p.name, p.state === "failed" ? p.reason : p.state]));
    assert.match(reasons["not-a-plugin"]!, /not a plugin: package.json has no "testapp" field/);
    assert.match(reasons["old-api"]!, /targets plugin API v0, but this host supports v1/);
    assert.match(reasons["no-entry"]!, /has no "entry"/);
    assert.match(reasons["bad-export"]!, /must export a plugin/);
    assert.match(reasons["throws"]!, /failed to import/);
    assert.match(reasons["missing"]!, /package not found/);
    assert.equal(reasons["fine"], "started");
  });

  test("strict mode rejects on the first package that fails to load", async () => {
    const root = await project({});
    await assert.rejects(host("strict").load(["missing"], { cwd: root }), /\[missing\] package not found/);
  });
});
