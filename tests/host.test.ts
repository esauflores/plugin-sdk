import assert from "node:assert/strict";
import { describe, test } from "vitest";

import { definePlugin, PluginError, PluginHost, TimeoutError, type Plugin } from "@/index.ts";

import { app, silent } from "./helpers.ts";

const host = (opts: Partial<ConstructorParameters<typeof PluginHost>[0]> = {}) =>
  new PluginHost({ app, logger: silent, ...opts });

function tracked(events: string[], name: string, extra: Partial<Plugin> = {}): Plugin {
  return {
    name,
    setup: () => void events.push(`setup:${name}`),
    start: () => void events.push(`start:${name}`),
    stop: () => void events.push(`stop:${name}`),
    ...extra,
  };
}

describe("lifecycle", () => {
  test("sets up all plugins before starting any, in dependency order, and stops in reverse", async () => {
    const events: string[] = [];
    const h = host()
      .register(tracked(events, "c", { dependsOn: ["b"] }))
      .register(tracked(events, "a"))
      .register(tracked(events, "b", { dependsOn: ["a"] }));

    await h.start();
    assert.deepEqual(events, ["setup:a", "setup:b", "setup:c", "start:a", "start:b", "start:c"]);
    assert.equal(h.phase, "started");

    events.length = 0;
    await h.stop();
    assert.deepEqual(events, ["stop:c", "stop:b", "stop:a"]);
    assert.ok(h.list().every((p) => p.state === "stopped"));
    assert.equal(h.phase, "stopped");
  });

  test("keeps registration order between independent plugins", async () => {
    const events: string[] = [];
    await host().register(tracked(events, "x")).register(tracked(events, "y")).register(tracked(events, "z")).start();
    assert.deepEqual(events.slice(0, 3), ["setup:x", "setup:y", "setup:z"]);
  });

  test("passes options and aborts the signal before stop, then runs disposers in reverse", async () => {
    const events: string[] = [];
    let signal!: AbortSignal;
    const h = host().register(
      definePlugin<{ port: number }>({
        name: "server",
        setup(ctx) {
          assert.deepEqual(ctx.options, { port: 8080 });
          signal = ctx.signal;
          ctx.onDispose(() => void events.push("dispose:1"));
          ctx.onDispose(async () => void events.push("dispose:2"));
        },
        stop: () => void events.push(`stop (aborted=${signal.aborted})`),
      }),
      { port: 8080 },
    );
    await h.start();
    assert.equal(signal.aborted, false);
    await h.stop();
    assert.deepEqual(events, ["stop (aborted=true)", "dispose:2", "dispose:1"]);
  });

  test("stop is idempotent and safe to call concurrently", async () => {
    let stops = 0;
    const h = host().register({ name: "p", setup() {}, stop: () => void stops++ });
    await h.start();
    await Promise.all([h.stop(), h.stop()]);
    await h.stop();
    assert.equal(stops, 1);
  });

  test("stop during start waits for the current plugin, then skips the rest", async () => {
    const events: string[] = [];
    let release!: () => void;
    const h = host()
      .register(tracked(events, "slow", { setup: () => new Promise<void>((r) => (release = r)) }))
      .register(tracked(events, "next"));
    const starting = h.start();
    const stopping = h.stop();
    while (!release) await new Promise((r) => setTimeout(r, 1));
    release();
    await Promise.all([starting, stopping]);
    assert.deepEqual(events, []);
    assert.equal(h.get("next")!.state, "registered");
    assert.equal(h.phase, "stopped");
  });

  test("rejects registration after start, and starting twice", async () => {
    const h = host().register({ name: "a", setup() {} });
    await h.start();
    assert.throws(() => h.register({ name: "b", setup() {} }), /Cannot register plugins: host is started/);
    assert.throws(() => h.start(), /Cannot start/);
  });

  test("rejects duplicate names and invalid plugins", () => {
    const h = host().register({ name: "a", setup() {} });
    assert.throws(() => h.register({ name: "a", setup() {} }), /already registered/);
    assert.throws(() => h.register({ name: "b" } as Plugin), /not a valid plugin/);
  });

  test("reports state transitions", async () => {
    const seen: string[] = [];
    const h = host().register({ name: "a", setup() {} });
    h.onStateChange((p, prev) => seen.push(`${p.name}:${prev}->${p.state}`));
    await h.start();
    await h.stop();
    assert.deepEqual(seen, ["a:registered->setup", "a:setup->started", "a:started->stopped"]);
  });
});

describe("services", () => {
  test("dependents can use services provided by their dependencies", async () => {
    let got: unknown;
    await host()
      .register({ name: "db", setup: (ctx) => ctx.provide("db", { query: () => 42 }) })
      .register({ name: "api", dependsOn: ["db"], setup: (ctx) => void (got = ctx.use("db").query()) })
      .start();
    assert.equal(got, 42);
  });

  test("using a service without declaring the dependency fails", async () => {
    const h = host()
      .register({ name: "db", setup: (ctx) => ctx.provide("db", {}) })
      .register({ name: "api", setup: (ctx) => void ctx.use("db") });
    await h.start();
    const api = h.get("api")!;
    assert.equal(api.state, "failed");
    assert.match(api.reason!, /without listing "db" in dependsOn/);
  });

  test("host services are available to every plugin; tryUse returns undefined when missing", async () => {
    const h = host();
    h.provide("config", { debug: true });
    let config: unknown,
      missing: unknown = "unset";
    h.register({
      name: "p",
      setup(ctx) {
        config = ctx.use("config");
        missing = ctx.tryUse("nope");
      },
    });
    await h.start();
    assert.deepEqual(config, { debug: true });
    assert.equal(missing, undefined);
  });

  test("duplicate providers fail, and services disappear on teardown", async () => {
    const h = host()
      .register({ name: "a", setup: (ctx) => ctx.provide("x", 1) })
      .register({ name: "b", setup: (ctx) => ctx.provide("x", 2) });
    await h.start();
    assert.match(h.get("b")!.reason!, /already provided by "a"/);
    assert.equal(h.service("x"), 1);
    await h.stop();
    assert.equal(h.service("x"), undefined);
  });
});

describe("failure handling (isolate)", () => {
  test("a failed setup disables dependents but not unrelated plugins", async () => {
    const h = host()
      .register({
        name: "a",
        setup: () => {
          throw new Error("boom");
        },
      })
      .register({ name: "b", dependsOn: ["a"], setup() {} })
      .register({ name: "c", setup() {} });
    await h.start();
    assert.equal(h.get("a")!.state, "failed");
    assert.match(h.get("a")!.reason!, /setup failed: boom/);
    assert.equal(h.get("b")!.state, "disabled");
    assert.match(h.get("b")!.reason!, /dependency "a" is failed/);
    assert.equal(h.get("c")!.state, "started");
  });

  test("a failed start tears down dependents that already set up", async () => {
    const events: string[] = [];
    const h = host()
      .register({
        name: "a",
        setup() {},
        start: () => {
          throw new Error("no port");
        },
      })
      .register({
        name: "b",
        dependsOn: ["a"],
        setup(ctx) {
          ctx.hooks.on("ping", () => "pong");
          ctx.onDispose(() => void events.push("dispose:b"));
        },
      });
    await h.start();
    assert.equal(h.get("a")!.state, "failed");
    assert.equal(h.get("b")!.state, "disabled");
    assert.deepEqual(events, ["dispose:b"]);
    assert.equal(h.hooks.count("ping"), 0);
  });

  test("missing dependencies and cycles disable the plugin", async () => {
    const h = host()
      .register({ name: "lonely", dependsOn: ["ghost"], setup() {} })
      .register({ name: "x", dependsOn: ["y"], setup() {} })
      .register({ name: "y", dependsOn: ["x"], setup() {} })
      .register({ name: "ok", optionalDependsOn: ["ghost"], setup() {} });
    await h.start();
    assert.match(h.get("lonely")!.reason!, /missing dependency "ghost"/);
    assert.match(h.get("x")!.reason!, /dependency cycle among: x, y/);
    assert.equal(h.get("y")!.state, "disabled");
    assert.equal(h.get("ok")!.state, "started");
  });

  test("a hanging setup times out and its signal is aborted", async () => {
    let signal!: AbortSignal;
    const h = host({ timeoutMs: 30 }).register({
      name: "hang",
      setup(ctx) {
        signal = ctx.signal;
        return new Promise(() => {});
      },
    });
    await h.start();
    const p = h.get("hang")!;
    assert.equal(p.state, "failed");
    assert.ok(p.error instanceof TimeoutError);
    assert.ok(signal.aborted);
  });

  test("a failing stop or disposer doesn't prevent the others from stopping", async () => {
    const events: string[] = [];
    const h = host()
      .register(tracked(events, "a"))
      .register(
        tracked(events, "b", {
          stop: () => {
            throw new Error("stuck");
          },
        }),
      )
      .register({
        name: "c",
        setup: (ctx) =>
          ctx.onDispose(() => {
            throw new Error("leak");
          }),
      });
    await h.start();
    await h.stop();
    assert.deepEqual(events, ["setup:a", "setup:b", "start:a", "start:b", "stop:a"]);
    assert.ok(h.list().every((p) => p.state === "stopped"));
  });
});

describe("failure handling (strict)", () => {
  test("the first failure rejects start and tears down everything already set up", async () => {
    const events: string[] = [];
    const h = host({ failure: "strict" })
      .register({ name: "a", setup: (ctx) => ctx.onDispose(() => void events.push("dispose:a")) })
      .register({
        name: "b",
        setup() {},
        start: () => {
          throw new Error("boom");
        },
      });
    await assert.rejects(h.start(), (err: unknown) => {
      assert.ok(err instanceof PluginError);
      assert.equal(err.plugin, "b");
      assert.equal(err.phase, "start");
      assert.equal((err.cause as Error).message, "boom");
      return true;
    });
    assert.deepEqual(events, ["dispose:a"]);
    assert.equal(h.phase, "stopped");
  });

  test("a missing dependency rejects start", async () => {
    const h = host({ failure: "strict" }).register({ name: "a", dependsOn: ["ghost"], setup() {} });
    await assert.rejects(h.start(), /missing dependency "ghost"/);
  });
});
