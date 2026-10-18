import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { z } from "zod";

import { definePlugin, PluginError, PluginHost, SchemaError, type StandardSchemaV1 } from "@/index.ts";

import { app, silent } from "./helpers.ts";

const host = <H extends object = any>(opts: Partial<ConstructorParameters<typeof PluginHost<H>>[0]> = {}) =>
  new PluginHost<H>({ app, logger: silent, ...opts });

describe("plugin options", () => {
  const server = definePlugin({
    name: "server",
    optionsSchema: z.object({ port: z.number().int(), host: z.string().default("localhost") }),
    setup(ctx) {
      // Inferred from the schema: a typo or wrong type here fails `tsc`.
      const port: number = ctx.options.port;
      const hostname: string = ctx.options.host;
      ctx.provide("address", `${hostname}:${port}`);
    },
  });

  test("passes the parsed options, with defaults applied, to the plugin", async () => {
    const h = host().register(server, { port: 8080 }); // `host` is optional here: the schema has a default
    await h.start();
    assert.equal(h.service("address"), "localhost:8080");
  });

  test("marks the plugin failed when options are invalid, naming the field", async () => {
    let setupRan = false;
    const h = host()
      // @ts-expect-error -- port must be a number; checked at compile time and at runtime
      .register({ ...server, setup: () => void (setupRan = true) }, { port: "80" })
      .register({ name: "api", dependsOn: ["server"], setup() {} });
    await h.start();

    const info = h.get("server")!;
    assert.equal(info.state, "failed");
    assert.match(info.reason!, /^invalid options: port: /);
    assert.ok(info.error instanceof SchemaError);
    assert.equal(setupRan, false);
    assert.equal(h.get("api")!.state, "disabled");
  });

  test("strict mode rejects start on invalid options", async () => {
    // @ts-expect-error -- port is required
    const h = host({ failure: "strict" }).register(server, {});
    await assert.rejects(h.start(), /\[server\] invalid options: port:/);
  });

  test("accepts any Standard Schema, including async validators", async () => {
    const evenNumber: StandardSchemaV1<unknown, number> = {
      "~standard": {
        version: 1,
        vendor: "hand-written",
        validate: async (value) =>
          typeof value === "number" && value % 2 === 0 ? { value } : { issues: [{ message: "must be even" }] },
      },
    };
    const h = host()
      .register({ name: "ok", optionsSchema: evenNumber, setup() {} }, 4)
      .register({ name: "odd", optionsSchema: evenNumber, setup() {} }, 3);
    await h.start();
    assert.equal(h.get("ok")!.state, "started");
    assert.equal(h.get("odd")!.reason, "invalid options: must be even");
  });
});

describe("hook result schemas", () => {
  interface Hooks {
    render: (html: string) => string | void;
    resolve: (id: string) => { id: string; size: number } | undefined;
  }

  const hookSchemas = {
    render: z.string().max(20),
    resolve: z.object({ id: z.string(), size: z.number().nonnegative() }),
  };

  test("valid results pass through, and the schema's output is used", async () => {
    const h = host<Hooks>({ hookSchemas: { ...hookSchemas, render: z.string().transform((s) => s.trim()) } });
    h.hooks.scope("a").on("render", (html) => `  ${html}!  `);
    h.hooks.scope("b").on("render", (html) => `${html}?`);
    assert.equal(await h.hooks.waterfall("render", "hi"), "hi!?");
  });

  test("an invalid waterfall result rejects with the offending plugin's name", async () => {
    const h = host<Hooks>({ hookSchemas, hookErrors: "throw" });
    h.hooks.scope("good").on("render", (html) => html.toUpperCase());
    h.hooks.scope("bloated").on("render", (html) => html.repeat(10));
    await assert.rejects(h.hooks.waterfall("render", "hello"), (err: unknown) => {
      assert.ok(err instanceof PluginError);
      assert.equal(err.plugin, "bloated");
      assert.match(err.message, /handler for "render" returned an invalid value: Too big/);
      return true;
    });
  });

  test("bail checks the result it returns; undefined still means 'skip'", async () => {
    const h = host<Hooks>({ hookSchemas, hookErrors: "throw" });
    h.hooks.scope("skip").on("resolve", () => undefined);
    h.hooks.scope("bad").on("resolve", (id) => ({ id, size: -1 }));
    await assert.rejects(h.hooks.bail("resolve", "x"), /\[bad\] .*size: /);
  });

  test("hooks without a schema are not checked", async () => {
    const h = host<Hooks>({ hookSchemas: {} });
    h.hooks.on("render", (html) => html.repeat(10));
    assert.equal((await h.hooks.waterfall("render", "abc")).length, 30);
  });
});
