import assert from "node:assert/strict";
import { describe, test } from "vitest";

import { HookBus, PluginError } from "@/index.ts";

interface TestHooks {
  event: (n: number) => void;
  transform: (text: string, suffix: string) => string | void;
  resolve: (id: string) => string | undefined | Promise<string | undefined>;
}

describe("HookBus", () => {
  test("call runs handlers serially in registration order", async () => {
    const bus = new HookBus<TestHooks>();
    const seen: string[] = [];
    bus.on("event", async (n) => {
      await new Promise((r) => setTimeout(r, 5));
      seen.push(`a${n}`);
    });
    bus.on("event", (n) => void seen.push(`b${n}`));
    await bus.call("event", 1);
    assert.deepEqual(seen, ["a1", "b1"]);
  });

  test("parallel runs handlers concurrently", async () => {
    const bus = new HookBus<TestHooks>();
    const seen: string[] = [];
    bus.on("event", async () => {
      await new Promise((r) => setTimeout(r, 10));
      seen.push("slow");
    });
    bus.on("event", () => void seen.push("fast"));
    await bus.parallel("event", 1);
    assert.deepEqual(seen, ["fast", "slow"]);
  });

  test("waterfall threads the value and keeps it when a handler returns undefined", async () => {
    const bus = new HookBus<TestHooks>();
    bus.on("transform", (text, suffix) => text + suffix);
    bus.on("transform", () => undefined);
    bus.on("transform", (text) => text.toUpperCase());
    assert.equal(await bus.waterfall("transform", "hi", "!"), "HI!");
    assert.equal(await new HookBus<TestHooks>().waterfall("transform", "same", ""), "same");
  });

  test("bail returns the first defined result and skips the rest", async () => {
    const bus = new HookBus<TestHooks>();
    let reachedLast = false;
    bus.on("resolve", () => undefined);
    bus.on("resolve", async (id) => (id === "x" ? "found-x" : undefined));
    bus.on("resolve", () => {
      reachedLast = true;
      return "fallback";
    });
    assert.equal(await bus.bail("resolve", "x"), "found-x");
    assert.equal(reachedLast, false);
    assert.equal(await bus.bail("resolve", "y"), "fallback");
  });

  test("off and removeOwner unregister handlers", async () => {
    const bus = new HookBus<TestHooks>();
    const off = bus.on("event", () => {});
    const scoped = bus.scope("plugin-a");
    scoped.on("event", () => {});
    scoped.on("transform", () => {});
    assert.equal(bus.count("event"), 2);
    off();
    bus.removeOwner("plugin-a");
    assert.equal(bus.count("event"), 0);
    assert.equal(bus.count("transform"), 0);
  });

  test("handlers added during an emit don't run in that emit", async () => {
    const bus = new HookBus<TestHooks>();
    let late = 0;
    bus.on("event", () => void bus.on("event", () => void late++));
    await bus.call("event", 1);
    assert.equal(late, 0);
    assert.equal(bus.count("event"), 2);
  });

  test("errors are wrapped with the owning plugin's name", async () => {
    const bus = new HookBus<TestHooks>();
    bus.scope("bad-plugin").on("event", () => {
      throw new Error("nope");
    });
    await assert.rejects(bus.call("event", 1), (err: unknown) => {
      assert.ok(err instanceof PluginError);
      assert.equal(err.plugin, "bad-plugin");
      assert.equal(err.phase, "hook");
      assert.match(err.message, /handler for "event" threw/);
      return true;
    });
  });
});
