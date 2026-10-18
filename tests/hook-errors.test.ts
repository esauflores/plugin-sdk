import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { z } from "zod";

import { type HookErrorPolicy, type Logger, PluginError, PluginHost, type PluginInfo } from "@/index.ts";

import { app } from "./helpers.ts";

interface Hooks {
  event: (n: number) => void;
  render: (html: string) => string | void;
  resolve: (id: string) => string | undefined;
  inner: () => void;
}

function recordingLogger() {
  const errors: unknown[] = [];
  const warnings: unknown[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (...args) => void warnings.push(args.join(" ")),
    error: (...args) => void errors.push(args[0]),
  };

  return { logger, errors, warnings };
}

async function started(
  hookErrors: HookErrorPolicy | undefined,
  ...plugins: Parameters<PluginHost<Hooks>["register"]>[0][]
) {
  const log = recordingLogger();
  const host = new PluginHost<Hooks>({ app, logger: log.logger, hookErrors });

  for (const plugin of plugins) host.register(plugin);
  await host.start();

  return { host, ...log };
}

const thrower = (name: string, extra: object = {}) => ({
  name,
  setup: (ctx: any) => {
    ctx.hooks.on("event", () => {
      throw new Error(`${name} broke`);
    });
    ctx.hooks.on("render", () => {
      throw new Error(`${name} broke`);
    });
    ctx.hooks.on("resolve", () => {
      throw new Error(`${name} broke`);
    });
  },
  ...extra,
});

describe('hookErrors: "log" (default)', () => {
  test("call logs the error and keeps running the other handlers", async () => {
    const seen: number[] = [];
    const { host, errors } = await started(undefined, thrower("bad"), {
      name: "good",
      setup: (ctx) => void ctx.hooks.on("event", (n) => void seen.push(n)),
    });

    await host.hooks.call("event", 1);
    await host.hooks.parallel("event", 2);

    assert.deepEqual(seen, [1, 2]);
    assert.equal(errors.length, 2);
    assert.ok(errors[0] instanceof PluginError && errors[0].plugin === "bad");
    assert.equal(host.get("bad")!.state, "started");
  });

  test("waterfall keeps the value from before the failing handler; bail moves on", async () => {
    const { host } = await started(
      undefined,
      { name: "first", setup: (ctx) => void ctx.hooks.on("render", (h) => `<b>${h}</b>`) },
      thrower("bad"),
      {
        name: "last",
        setup(ctx) {
          ctx.hooks.on("render", (h) => `${h}!`);
          ctx.hooks.on("resolve", (id) => `found ${id}`);
        },
      },
    );

    assert.equal(await host.hooks.waterfall("render", "hi"), "<b>hi</b>!");
    assert.equal(await host.hooks.bail("resolve", "x"), "found x");
  });

  test("an invalid result is treated like a thrown error", async () => {
    const log = recordingLogger();
    const host = new PluginHost<Hooks>({ app, logger: log.logger, hookSchemas: { render: z.string().max(5) } })
      .register({ name: "long", setup: (ctx) => void ctx.hooks.on("render", (h) => h.repeat(10)) })
      .register({ name: "ok", setup: (ctx) => void ctx.hooks.on("render", (h) => `${h}?`) });
    await host.start();

    assert.equal(await host.hooks.waterfall("render", "ab"), "ab?");
    assert.match(String(log.errors[0]), /\[long\] handler for "render" returned an invalid value/);
  });

  test("errors from the app's own handlers still propagate", async () => {
    const { host } = await started(undefined);

    host.hooks.on("event", () => {
      throw new Error("app bug");
    });

    await assert.rejects(host.hooks.call("event", 1), /\[<host>\] handler for "event" threw/);
  });
});

describe('hookErrors: "disable"', () => {
  test("stops the failing plugin and its started dependents; others keep running", async () => {
    const events: string[] = [];
    const transitions: string[] = [];
    const tracked = (name: string, extra: object = {}) => ({
      name,
      setup: (ctx: any) => ctx.onDispose(() => void events.push(`dispose:${name}`)),
      stop: () => void events.push(`stop:${name}`),
      ...extra,
    });

    const { host, warnings } = await started(
      "disable",
      thrower("db", { stop: () => void events.push("stop:db") }),
      tracked("api", { dependsOn: ["db"] }),
      tracked("ui", { dependsOn: ["api"] }),
      tracked("metrics", { optionalDependsOn: ["db"] }),
      tracked("other"),
    );
    host.onStateChange((p: PluginInfo, prev) => transitions.push(`${p.name}:${prev}->${p.state}`));

    await host.hooks.call("event", 1);

    assert.deepEqual(events, ["stop:ui", "dispose:ui", "stop:api", "dispose:api", "stop:db"]);
    assert.deepEqual(transitions, ["ui:started->disabled", "api:started->disabled", "db:started->failed"]);
    assert.match(host.get("db")!.reason!, /^disabled at runtime: handler for "event" threw/);
    assert.equal(host.get("api")!.reason, 'dependency "db" is failed');
    assert.equal(host.get("metrics")!.state, "started");
    assert.equal(host.get("other")!.state, "started");
    assert.equal(warnings.length, 2);
  });

  test("a disabled plugin's handlers stop running, even later in the same call", async () => {
    let secondHandlerRuns = 0;
    const { host } = await started("disable", {
      name: "flaky",
      setup(ctx) {
        ctx.hooks.on("event", () => {
          throw new Error("boom");
        });
        ctx.hooks.on("event", () => void secondHandlerRuns++);
      },
    });

    await host.hooks.call("event", 1);
    await host.hooks.call("event", 2);

    assert.equal(secondHandlerRuns, 0);
    assert.equal(host.hooks.count("event"), 0);
  });

  test("in a nested hook call, the plugin that actually failed is disabled", async () => {
    const { host } = await started(
      "disable",
      { name: "outer", setup: (ctx) => void ctx.hooks.on("event", () => ctx.hooks.call("inner")) },
      {
        name: "culprit",
        setup: (ctx) =>
          void ctx.hooks.on("inner", () => {
            throw new Error("deep");
          }),
      },
    );

    await host.hooks.call("event", 1);

    assert.equal(host.get("culprit")!.state, "failed");
    assert.equal(host.get("outer")!.state, "started");
  });

  test("concurrent failures stop the plugin only once", async () => {
    let stops = 0;
    const { host } = await started("disable", thrower("bad", { stop: () => void stops++ }));

    await Promise.all([host.hooks.parallel("event", 1), host.hooks.call("event", 2)]);

    assert.equal(stops, 1);
  });
});

describe('hookErrors: "throw"', () => {
  test("the hook call rejects with the PluginError naming the plugin", async () => {
    const { host } = await started("throw", thrower("bad"));

    await assert.rejects(host.hooks.call("event", 1), (err: unknown) => {
      assert.ok(err instanceof PluginError);
      assert.equal(err.plugin, "bad");
      assert.equal(err.reason, 'handler for "event" threw');

      return true;
    });
    assert.equal(host.get("bad")!.state, "started");
  });
});
