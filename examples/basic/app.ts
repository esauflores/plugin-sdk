import { z } from "zod";

import { definePluginFor, PluginHost } from "../../src/index.ts";

// 1. The app declares its extension points.
export interface AppHooks {
  "greeting:render": (text: string, who: string) => string | void;
}
export interface AppServices {
  clock: { now(): string };
}
const definePlugin = definePluginFor<AppHooks, AppServices>();

// 2. Local plugins.
const clock = definePlugin({
  name: "clock",
  setup: (ctx) => ctx.provide("clock", { now: () => new Date().toISOString().slice(11, 19) }),
});

const shout = definePlugin({
  name: "shout",
  optionsSchema: z.object({ suffix: z.string().default("!") }), // ctx.options is typed from this
  // "post": runs after greeter, without depending on it (shout uses none of its services).
  setup: (ctx) =>
    void ctx.hooks.on("greeting:render", (text) => text.toUpperCase() + ctx.options.suffix, { order: "post" }),
});

// 3. The host: local plugins + installed npm packages.
const host = new PluginHost<AppHooks, AppServices>({
  app: { name: "basic-example", version: "1.0.0" },
  // Every value a plugin returns from this hook is checked.
  hookSchemas: { "greeting:render": z.string().max(80) },
});
host.onStateChange((p, prev) => console.log(`  ${p.name.padEnd(8)} ${prev} → ${p.state}`));
host.register(clock).register(shout, { suffix: " 🎉" });
await host.load([["basic-example-plugin-greeter", { punctuation: "!" }]], { cwd: import.meta.dirname });

const runtime = typeof process.versions.bun === "string" ? `bun ${process.versions.bun}` : `node ${process.version}`;
console.log(`\n▶ start (${runtime})`);
await host.start();

console.log("\n▶ hook");
console.log(" ", await host.hooks.waterfall("greeting:render", "Hello", "world"));

console.log("\n▶ stop");
await host.stop();
