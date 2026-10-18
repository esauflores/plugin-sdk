import assert from "node:assert/strict";
import { describe, test } from "vitest";

import { HookBus, type HookInterceptor, PluginError, PluginHost } from "@/index.ts";

import { app, silent } from "./helpers.ts";

interface Hooks {
  render: (html: string) => string | void;
  event: (n: number) => void;
  resolve: (id: string) => string | undefined;
}

describe("hook order", () => {
  test('"pre" handlers run first and "post" last; registration order within each bucket', async () => {
    const bus = new HookBus<Hooks>();
    const seen: string[] = [];
    const track = (label: string) => () => void seen.push(label);

    bus.on("event", track("post-1"), { order: "post" });
    bus.on("event", track("normal-1"));
    bus.on("event", track("pre-1"), { order: "pre" });
    bus.on("event", track("normal-2"), { order: "normal" });
    bus.on("event", track("pre-2"), { order: "pre" });
    bus.on("event", track("post-2"), { order: "post" });

    await bus.call("event", 1);

    assert.deepEqual(seen, ["pre-1", "pre-2", "normal-1", "normal-2", "post-1", "post-2"]);
  });

  test("lets unrelated plugins agree on a waterfall order without dependsOn", async () => {
    // banner registers first, but must run after minify, which would mangle it.
    const host = new PluginHost<Hooks>({ app, logger: silent })
      .register({
        name: "banner",
        setup: (ctx) => void ctx.hooks.on("render", (html) => `<!-- built -->\n${html}`, { order: "post" }),
      })
      .register({ name: "minify", setup: (ctx) => void ctx.hooks.on("render", (html) => html.replace(/\s+/g, "")) });
    await host.start();

    assert.equal(await host.hooks.waterfall("render", "<p> hi </p>"), "<!-- built -->\n<p>hi</p>");
  });

  test("rejects an unknown order", () => {
    const bus = new HookBus<Hooks>();

    assert.throws(
      () => bus.on("event", () => {}, { order: "first" as any }),
      /Hook order must be "pre", "normal" or "post"/,
    );
  });
});

describe("interceptors", () => {
  function recorder() {
    const calls: string[] = [];
    const handlers: Array<{ hook: string; plugin: string | undefined; ms: number; error?: unknown }> = [];
    const interceptor: HookInterceptor = {
      call: ({ hook, style, args }) => void calls.push(`${style}:${hook}(${args.join(",")})`),
      handler: (event) => void handlers.push(event),
    };

    return { calls, handlers, interceptor };
  }

  test("see every call with its style and arguments, and every handler with its plugin", async () => {
    const { calls, handlers, interceptor } = recorder();
    const host = new PluginHost<Hooks>({ app, logger: silent })
      .register({ name: "a", setup: (ctx) => void ctx.hooks.on("render", (h) => `${h}!`) })
      .register({ name: "b", setup: (ctx) => void ctx.hooks.on("resolve", (id) => `found ${id}`) });
    await host.start();
    host.hooks.on("event", () => {});
    host.hooks.intercept(interceptor);

    await host.hooks.waterfall("render", "hi");
    await host.hooks.bail("resolve", "x");
    await host.hooks.call("event", 1);
    await host.hooks.parallel("event", 2);

    assert.deepEqual(calls, ["waterfall:render(hi)", "bail:resolve(x)", "call:event(1)", "parallel:event(2)"]);
    assert.deepEqual(
      handlers.map((e) => [e.hook, e.plugin]),
      [
        ["render", "a"],
        ["resolve", "b"],
        ["event", undefined],
        ["event", undefined],
      ],
    );
    assert.ok(handlers.every((e) => typeof e.ms === "number" && e.ms >= 0 && !("error" in e)));
  });

  test("report failing handlers with their error, including handled ones", async () => {
    const { handlers, interceptor } = recorder();
    const host = new PluginHost<Hooks>({ app, logger: silent }).register({
      name: "bad",
      setup: (ctx) =>
        void ctx.hooks.on("event", () => {
          throw new Error("boom");
        }),
    });
    await host.start();
    host.hooks.intercept(interceptor);

    await host.hooks.call("event", 1); // hookErrors "log": skipped, but still reported

    assert.equal(handlers.length, 1);
    assert.equal(handlers[0].plugin, "bad");
    assert.ok(handlers[0].error instanceof PluginError);
  });

  test("measure handler time, so slow plugins can be found", async () => {
    const slow: string[] = [];
    const host = new PluginHost<Hooks>({ app, logger: silent })
      .register({ name: "fast", setup: (ctx) => void ctx.hooks.on("event", () => {}) })
      .register({
        name: "sluggish",
        setup: (ctx) => void ctx.hooks.on("event", () => new Promise((r) => setTimeout(r, 25))),
      });
    await host.start();
    host.hooks.intercept({ handler: ({ plugin, ms }) => void (ms >= 20 && slow.push(plugin!)) });

    await host.hooks.call("event", 1);

    assert.deepEqual(slow, ["sluggish"]);
  });

  test("can be removed, and are not available to plugins", async () => {
    const { calls, interceptor } = recorder();
    let pluginView: object = {};
    const host = new PluginHost<Hooks>({ app, logger: silent }).register({
      name: "p",
      setup: (ctx) => void (pluginView = ctx.hooks),
    });
    await host.start();

    const remove = host.hooks.intercept(interceptor);
    await host.hooks.call("event", 1);
    remove();
    await host.hooks.call("event", 2);

    assert.deepEqual(calls, ["call:event(1)"]);
    assert.equal("intercept" in pluginView, false);
  });
});
