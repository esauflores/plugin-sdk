import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { HookSchemas, Hooks } from "./hooks.ts";

/** Any schema library implementing https://standardschema.dev: zod, valibot, ArkType... */
export type { StandardSchemaV1 };

export interface AppInfo {
  /** Also the default `package.json` key plugins use for their manifest. */
  name: string;
  version: string;
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * `H` is the app's hook map, `S` its service map, e.g.
 *   interface MyHooks { "request": (req: Request) => void }
 *   interface MyServices { db: Database }
 * `Options` is what the plugin receives in `ctx.options`; `Input` is what callers pass to
 * `register()` / `load()`. They differ when `optionsSchema` applies defaults or transforms.
 */
export interface Plugin<Options = any, H extends object = any, S extends object = any, Input = Options> {
  /** Unique within a host. */
  name: string;
  version?: string;
  /** Plugins that must set up and start before this one. If one fails, this plugin is disabled. */
  dependsOn?: readonly string[];
  /** Ordered before this plugin when present; ignored when missing or failed. */
  optionalDependsOn?: readonly string[];
  /**
   * Validates the options before `setup`; `ctx.options` is the parsed result (defaults applied)
   * and its type is inferred from the schema. Invalid options mark the plugin failed.
   */
  optionsSchema?: StandardSchemaV1<Input, Options>;
  /** Register hooks and provide services. Avoid side effects (sockets, timers) here: that is what `start` is for. */
  setup(ctx: PluginContext<Options, H, S>): void | Promise<void>;
  /** Called once every plugin has set up, in dependency order. */
  start?(ctx: PluginContext<Options, H, S>): void | Promise<void>;
  /** Called in reverse dependency order. `ctx.signal` is already aborted; disposers run right after. */
  stop?(ctx: PluginContext<Options, H, S>): void | Promise<void>;
}

export interface PluginContext<Options = any, H extends object = any, S extends object = any> {
  readonly name: string;
  readonly options: Options;
  readonly app: AppInfo;
  /** Aborted when the plugin starts stopping, fails, or times out. Pass it to fetch, timers, servers... */
  readonly signal: AbortSignal;
  readonly log: Logger;
  /** Handlers registered here are removed automatically when the plugin is torn down. */
  readonly hooks: Hooks<H>;
  /** Removed automatically when the plugin is torn down. */
  provide<K extends keyof S & string>(key: K, value: S[K]): void;
  /** Throws if missing, or if the provider is not listed in `dependsOn` / `optionalDependsOn`. */
  use<K extends keyof S & string>(key: K): S[K];
  /** Like `use`, but returns undefined when the service is missing (for optional dependencies). */
  tryUse<K extends keyof S & string>(key: K): S[K] | undefined;
  /** Runs on teardown in reverse registration order, after `stop`. */
  onDispose(fn: () => unknown): void;
}

export type PluginState =
  | "registered" // known, not set up yet
  | "setup" // setup() succeeded
  | "started" // start() succeeded
  | "stopped" // torn down cleanly
  | "failed" // load/setup/start threw or timed out
  | "disabled"; // skipped: missing/failed dependency or dependency cycle

export interface PluginInfo {
  name: string;
  version?: string;
  /** "inline" for `host.register()`, otherwise the package specifier passed to `host.load()`. */
  source: string;
  state: PluginState;
  /** Why the plugin failed or was disabled. */
  reason?: string;
  error?: unknown;
}

export type HookErrorPolicy =
  /** Log the error, skip that handler and continue. */
  | "log"
  /** Log the error, then stop the plugin (state "failed") and the started plugins that depend on it. */
  | "disable"
  /** Make the hook call reject with the PluginError. */
  | "throw";

export type FailurePolicy =
  /** A failing plugin is torn down, its dependents disabled, and the rest keep running. */
  | "isolate"
  /** The first failure stops everything and rejects `start()` / `load()`. */
  | "strict";

export interface HostOptions<H extends object = any> {
  app: AppInfo;
  /**
   * Schemas for values plugins return from `waterfall` and `bail` hooks. A handler returning
   * an invalid value makes the hook call reject with a PluginError naming that plugin.
   */
  hookSchemas?: NoInfer<HookSchemas<H>>;
  /** Plugins declare the API version they target in their manifest; it must match. Bump it on breaking changes. Default 1. */
  apiVersion?: number;
  /** `package.json` field holding the plugin manifest. Defaults to `app.name`. */
  manifestKey?: string;
  logger?: Logger;
  /** Per-plugin limit for each of setup/start/stop. 0 disables. Default 10s. */
  timeoutMs?: number;
  /** Default "isolate". */
  failure?: FailurePolicy;
  /**
   * What happens when a plugin's hook handler throws, or returns a value its hook schema rejects,
   * while the app runs. Errors from your app's own handlers always propagate. Default "log".
   */
  hookErrors?: HookErrorPolicy;
}

/** A package name (`"my-plugin"`, `"@scope/my-plugin"`), a path (`"./plugins/foo"`), or either with options. */
export type PluginSpec = string | readonly [specifier: string, options: unknown];

/** What a plugin package puts under its manifest key in package.json. */
export interface PluginManifest {
  apiVersion: number;
  /** Relative to the package root, e.g. "./dist/index.js". */
  entry: string;
}

export type HostPhase = "idle" | "starting" | "started" | "stopping" | "stopped";
export type StateListener = (plugin: PluginInfo, previous: PluginState) => void;

export type ErrorPhase = "register" | "load" | "setup" | "start" | "stop" | "dispose" | "hook" | "service";

/** Every error the SDK raises about a specific plugin. `cause` holds the original error, if any. */
export class PluginError extends Error {
  readonly plugin: string;
  readonly phase: ErrorPhase;
  /** The message without the `[plugin]` prefix. */
  readonly reason: string;

  constructor(plugin: string, phase: ErrorPhase, message: string, options?: ErrorOptions) {
    super(`[${plugin}] ${message}`, options);
    this.name = "PluginError";
    this.plugin = plugin;
    this.phase = phase;
    this.reason = message;
  }
}

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

export class SchemaError extends Error {
  readonly issues: readonly StandardSchemaV1.Issue[];

  constructor(issues: readonly StandardSchemaV1.Issue[]) {
    super(issues.map(formatIssue).join("; "));
    this.name = "SchemaError";
    this.issues = issues;
  }
}

/** Runs a Standard Schema and returns its output, or throws a SchemaError listing the issues. */
export async function parseWith<T>(schema: StandardSchemaV1<unknown, T>, value: unknown): Promise<T> {
  const result = await schema["~standard"].validate(value);
  if (result.issues) throw new SchemaError(result.issues);

  return result.value;
}

function formatIssue(issue: StandardSchemaV1.Issue): string {
  const path = (issue.path ?? []).map((p) => String(typeof p === "object" ? p.key : p)).join(".");

  return path ? `${path}: ${issue.message}` : issue.message;
}

// Duck-typed rather than branded: a plugin may have been built against a
// different copy of this SDK, so instanceof/symbol checks would reject it.
export function isPlugin(value: unknown): value is Plugin {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Plugin).name === "string" &&
    (value as Plugin).name.length > 0 &&
    typeof (value as Plugin).setup === "function"
  );
}
