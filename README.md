# plugin-sdk

A plugin system for **Bun and Node (24+)**. Its one dependency is `@standard-schema/spec` (types only). Plugins are npm packages (or local objects),
trusted and run in-process. To use it, copy `src/` into your project (e.g. as `plugin-sdk/`).

```
src/
  index.ts    PluginHost, definePlugin, ordering + timeouts; re-exports types and hooks
  hooks.ts    HookBus: call / parallel / waterfall / bail
  loader.ts   finds, checks and imports plugin packages (the only file using node:fs)
  types.ts    the public contract: Plugin, PluginContext, options, errors, schema checks
```

`index.ts` imports `loader.ts` lazily inside `host.load()`. If you only use `host.register()`, the core never touches
Node APIs, so it can run in a browser, a Worker or an edge runtime (after a TypeScript build; only Bun and Node are tested).

The code only uses TypeScript syntax that can be erased (no enums, no parameter properties), and imports use `.ts`
extensions. Bun runs it as is, and so does Node 23.6+ (type stripping). For a project with a build step, keep
`allowImportingTsExtensions` or rewrite the imports to `.js`.

## Lifecycle

```
register / load ─► setup (all) ─► start (all) ─► stop (all, reversed) ─► dispose
                        │              │               │
                        └── failed / disabled ◄────────┘   (torn down, dependents disabled)
```

- **Order**: plugins are flat (no nesting) and sorted by `dependsOn`; ties keep registration order.
- **setup**: register hooks and `provide` services. Nothing with side effects goes here.
- **start**: open sockets, start timers. Every plugin has finished setup by this point.
- **stop**: `ctx.signal` aborts first, then `stop()` runs, then the `onDispose` callbacks run in reverse order. Hooks and services are removed automatically.
- **Failure** (`failure: "isolate"`, the default): the plugin is torn down and its dependents are disabled; everything else keeps running.
  With `"strict"`, the first failure tears everything down and `start()` rejects.
- **Hook errors at runtime** follow `hookErrors` (see below), so one bad handler doesn't break a hook for everyone.
- Each phase has a timeout (`timeoutMs`, 10s by default). A timeout aborts the plugin's signal.
- **A host is single-use.** ES modules can't be unloaded, so to reload plugins, create a new host or restart the process.

## The app (host)

```ts
import { PluginHost, definePluginFor } from "./plugin-sdk/index.ts";

export interface AppHooks {
  request: (req: Request) => Response | void;
}
export interface AppServices {
  db: Database;
}
export const definePlugin = definePluginFor<AppHooks, AppServices>();

const host = new PluginHost<AppHooks, AppServices>({
  app: { name: "my-app", version: "2.1.0" }, // name = manifest key in plugin package.json
  apiVersion: 1, // bump on breaking plugin-API changes
});

host.register(localPlugin);
await host.load(["my-app-plugin-auth", ["@acme/my-app-metrics", { interval: 10 }]]); // from node_modules
await host.start();

const res = await host.hooks.bail("request", req);

process.once("SIGTERM", () => host.stop());
```

`host.list()` / `host.get(name)` / `host.onStateChange()` report each plugin's state and, when one failed or was disabled, why.

## Writing a plugin

```ts
export default definePlugin<{ prefix: string }>({
  name: "auth",
  dependsOn: ["db"], // ordering + permission to use("db")
  setup(ctx) {
    const db = ctx.use("db");
    ctx.provide("auth", createAuth(db));
    ctx.hooks.on("request", (req) => (req.url.startsWith(ctx.options.prefix) ? check(req) : undefined));
  },
  async start(ctx) {
    const timer = setInterval(sweepSessions, 60_000);
    ctx.onDispose(() => clearInterval(timer));
  },
});
```

| Hook style  | Behaviour                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| `call`      | handlers run one after another; results ignored                                                               |
| `parallel`  | handlers run concurrently                                                                                     |
| `waterfall` | each handler gets the previous handler's result as its first argument (returning `undefined` keeps the value) |
| `bail`      | first result that isn't `undefined` wins; the remaining handlers are skipped                                  |

### Hook order

Handlers run in three buckets: `"pre"`, then `"normal"` (the default), then `"post"`, in registration order within
each. Use it when two plugins that don't depend on each other must agree on an order in a `waterfall` hook:

```ts
ctx.hooks.on("render", addBanner, { order: "post" }); // after minify, wherever minify registers
```

Order only places handlers; it doesn't create a dependency. Use `dependsOn` when you need the other plugin's services.

### Interceptors (host only)

`host.hooks.intercept()` observes every hook call, for tracing, metrics or finding slow plugins. Plugins can't
use it: their `ctx.hooks` has no `intercept`.

```ts
const remove = host.hooks.intercept({
  call: ({ hook, style, args }) => {}, // before any handler runs
  handler: ({ hook, plugin, ms, error }) => {
    // after each handler
    if (ms > 50) log.warn(`${plugin} took ${ms.toFixed(0)}ms in ${hook}`);
  },
});
```

- `plugin` is `undefined` for your app's own handlers, and `error` is set when the handler threw or returned an
  invalid value (even when `hookErrors` then skipped it).
- `ms` covers the handler and its result check, not what `hookErrors` does afterwards.
- Interceptors are your code: if one throws, the hook call rejects.

## Checking data at runtime (Standard Schema)

TypeScript types disappear at runtime, and plugin code from npm is JavaScript you don't control. The SDK accepts
any [Standard Schema](https://standardschema.dev) (zod, valibot, ArkType…) at the two places where data crosses
from a plugin into your app:

```ts
import { z } from "zod";

// 1. Plugin options: checked before setup(); ctx.options is the parsed value, typed from the schema.
const server = definePlugin({
  name: "server",
  optionsSchema: z.object({ port: z.number().int(), host: z.string().default("localhost") }),
  setup(ctx) {
    ctx.options.port; // number
  },
});
host.register(server, { port: 8080 }); // typed as the schema's input: `host` is optional

// 2. Hook results: every value a plugin returns from waterfall/bail is checked.
const host = new PluginHost<AppHooks>({
  app,
  hookSchemas: { render: z.string().max(10_000) },
});
```

- **Invalid options** mark the plugin `failed` with a reason like `invalid options: port: Invalid input…`, and
  its dependents are disabled. Options passed to `host.load()` are checked the same way.
- **An invalid hook result** counts as a hook error from the plugin that returned it, handled by `hookErrors`.
  If the schema transforms the value, the next handler (and your app) gets the transformed value.
- Hooks without a schema, and `call`/`parallel` (whose results are ignored), aren't checked.
- To give third-party plugin authors your types, publish the schemas in a small package (e.g. `my-app-plugin-api`):
  authors get types through `z.infer`, and the same schemas run at runtime.

## Hook errors at runtime

After startup, a plugin's hook handler can still throw, or return a value its hook schema rejects. The
`hookErrors` host option decides what happens:

| `hookErrors`      | The failing handler | The plugin                                                    | The hook call                                  |
| ----------------- | ------------------- | ------------------------------------------------------------- | ---------------------------------------------- |
| `"log"` (default) | logged and skipped  | keeps running                                                 | continues with the other handlers              |
| `"disable"`       | logged and skipped  | stopped as `failed`, and its started dependents as `disabled` | continues                                      |
| `"throw"`         | —                   | keeps running                                                 | rejects with a `PluginError` naming the plugin |

- When a handler is skipped, `waterfall` keeps the value from before it, and `bail` moves on to the next handler.
- `"disable"` stops plugins the same way `host.stop()` does: signal aborted, `stop()`, disposers, hooks and
  services removed. Dependents through `optionalDependsOn` keep running.
- In a nested hook call, the plugin whose handler actually failed is the one blamed.
- Errors from your app's own handlers (`host.hooks.on(...)`) always propagate: that's your code, not a plugin's.

## Publishing a plugin package

```json
{
  "name": "my-app-plugin-auth",
  "type": "module",
  "keywords": ["my-app-plugin"],
  "peerDependencies": { "my-app": "^2.0.0" },
  "my-app": { "apiVersion": 1, "entry": "./dist/index.js" }
}
```

- **Ship JavaScript.** Node won't strip types inside `node_modules`.
- **`apiVersion` is the compatibility check.** It must equal the host's `apiVersion`; bump it in the host when the plugin API breaks. `peerDependencies` ranges aren't checked.
- **Put the host in `peerDependencies`, not `dependencies`,** so the plugin doesn't install its own copy. The SDK checks plugins by shape rather than with `instanceof`, so a second copy isn't fatal, but it's wasteful.
- **`entry` is required.** It's the file the loader imports, relative to the package root.
- The loader looks for packages in `node_modules` in `cwd` and then in each parent directory. Relative paths (`"./plugins/foo"`) also work.
- Install scripts: npm runs `postinstall`; Bun doesn't unless the package is listed in `trustedDependencies`. Users install plugins at their own risk.

## Development

Tooling follows the `node-bun-base` template: Vite+ (`vp`) for format, lint and tests, TypeScript 7, and mise for
tool versions. The tests import `@/…`, which maps to `src/`; the SDK itself only uses relative imports, so `src/`
stays copyable.

```sh
mise install          # Node 24 + Bun
bun run check         # vp fmt --check, vp lint (type-aware), tsc
bun run check:fix     # same, applying fixes
bun run test          # vp test (Vitest on Node)
bun run test:bun      # the same tests on Bun
bun run example       # examples/basic on Bun and Node
```

CI (`.github/workflows/ci.yml`) runs the same steps on every push to `main` and on pull requests, with the
Node and Bun versions from `mise.toml`.

## License

MIT © 2026 Cesar Flores
