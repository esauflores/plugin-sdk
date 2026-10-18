// plugin-sdk: a plugin system for Bun and Node 24+. Its only dependency is @standard-schema/spec (types only).
//
// Lifecycle:  register/load → setup (all, in dependency order) → start (all) → stop (reverse order) → dispose

import { HookBus } from "./hooks.ts";
import {
  type AppInfo,
  type ErrorPhase,
  type FailurePolicy,
  type HostOptions,
  type HookErrorPolicy,
  type HostPhase,
  isPlugin,
  type Logger,
  parseWith,
  type Plugin,
  PluginError,
  type PluginContext,
  type PluginInfo,
  type PluginSpec,
  type PluginState,
  type StateListener,
  TimeoutError,
} from "./types.ts";

export * from "./types.ts";
export {
  HookBus,
  type HookErrorHandler,
  type HookFn,
  type HookInterceptor,
  type HookName,
  type HookOptions,
  type HookOrder,
  type Hooks,
  type HookSchemas,
  type HookStyle,
} from "./hooks.ts";

/** Identity helper for type inference. Untyped hooks/services; see `definePluginFor` for app-typed plugins. */
export function definePlugin<Options = void, Input = Options>(
  plugin: Plugin<Options, any, any, Input>,
): Plugin<Options, any, any, Input> {
  return plugin;
}

/**
 * Returns a `definePlugin` bound to your app's hook and service maps:
 *   export const definePlugin = definePluginFor<MyHooks, MyServices>();
 */
export function definePluginFor<H extends object, S extends object = {}>() {
  return <Options = void, Input = Options>(plugin: Plugin<Options, H, S, Input>): Plugin<Options, H, S, Input> =>
    plugin;
}

const HOST = "<host>";

interface Entry {
  plugin: Plugin;
  options: unknown;
  source: string;
  state: PluginState;
  reason?: string;
  error?: unknown;
  controller: AbortController;
  disposers: Array<() => unknown>;
  ctx?: PluginContext;
  tornDown: boolean;
}

/**
 * The host is single-use: once stopped it can't be started again. To reload plugins,
 * create a new host (or restart the process; ES modules can't be unloaded).
 */
export class PluginHost<H extends object = any, S extends object = any> {
  readonly app: AppInfo;
  /** Host-owned view of the hook bus: emit hooks from your app through this. */
  readonly hooks: HookBus<H>;

  readonly #apiVersion: number;
  readonly #manifestKey: string;
  readonly #log: Logger;
  readonly #timeoutMs: number;
  readonly #failure: FailurePolicy;
  readonly #hookErrors: HookErrorPolicy;

  readonly #entries = new Map<string, Entry>();
  readonly #services = new Map<string, { owner: string; value: unknown }>();
  readonly #listeners = new Set<StateListener>();

  #order: string[] = [];
  #phase: HostPhase = "idle";
  #starting?: Promise<void>;
  #stopping?: Promise<void>;

  constructor(options: HostOptions<H>) {
    this.app = options.app;
    this.hooks = new HookBus<H>(options.hookSchemas, (error) => this.#onHookError(error));
    this.#apiVersion = options.apiVersion ?? 1;
    this.#manifestKey = options.manifestKey ?? options.app.name;
    this.#log = options.logger ?? console;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#failure = options.failure ?? "isolate";
    this.#hookErrors = options.hookErrors ?? "log";
  }

  get phase(): HostPhase {
    return this.#phase;
  }

  /** Adds a plugin object directly (local plugins, or ones you imported yourself). */
  register<O, I = O>(plugin: Plugin<O, H, S, I>, options?: I): this {
    this.#add(plugin, options, "inline");

    return this;
  }

  /**
   * Loads installed plugin packages, resolving from `cwd`'s node_modules upwards.
   * Imports run in parallel; plugins are registered in the order given.
   * Under "isolate", a package that fails to load is listed as failed and skipped.
   */
  async load(specs: readonly PluginSpec[], { cwd = process.cwd() }: { cwd?: string } = {}): Promise<this> {
    this.#assertPhase("idle", "load plugins");

    // Imported lazily so the core never pulls in node:fs unless you load packages.
    const { loadPluginPackage } = await import("./loader.ts");

    const normalized = specs.map((spec) => (typeof spec === "string" ? ([spec, undefined] as const) : spec));
    const results = await Promise.allSettled(
      normalized.map(([specifier]) =>
        loadPluginPackage(specifier, { cwd, apiVersion: this.#apiVersion, manifestKey: this.#manifestKey }),
      ),
    );

    for (const [i, result] of results.entries()) {
      const [specifier, options] = normalized[i];

      if (result.status === "fulfilled") {
        this.#add(result.value, options, specifier);
        continue;
      }

      if (this.#failure === "strict") throw result.reason;
      this.#log.error(result.reason);

      if (!this.#entries.has(specifier)) {
        this.#entries.set(specifier, {
          ...newEntry({ name: specifier, setup() {} }, options, specifier),
          state: "failed",
          reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
          error: result.reason,
          tornDown: true,
        });
      }
    }

    return this;
  }

  /** Sets up every plugin, then starts every plugin, both in dependency order. */
  start(): Promise<void> {
    this.#assertPhase("idle", "start");

    this.#phase = "starting";
    this.#starting = this.#start();

    return this.#starting;
  }

  /** Stops started plugins in reverse order and tears everything down. Safe to call repeatedly or mid-start. */
  stop(): Promise<void> {
    this.#stopping ??= (async () => {
      await this.#starting?.catch(() => {});
      await this.#shutdown();
    })();

    return this.#stopping;
  }

  /** Services provided by the host are usable by every plugin without declaring a dependency. */
  provide<K extends keyof S & string>(key: K, value: S[K]): void {
    this.#provide(HOST, key, value);
  }

  service<K extends keyof S & string>(key: K): S[K] | undefined {
    return this.#services.get(key)?.value as S[K] | undefined;
  }

  list(): PluginInfo[] {
    return [...this.#entries.values()].map(info);
  }

  get(name: string): PluginInfo | undefined {
    const entry = this.#entries.get(name);

    return entry && info(entry);
  }

  onStateChange(listener: StateListener): () => void {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  }

  async #start(): Promise<void> {
    try {
      const { order, unresolved } = resolveOrder([...this.#entries.values()].map((e) => e.plugin));
      this.#order = order;

      for (const name of unresolved) {
        await this.#fail(
          this.#entries.get(name)!,
          "disabled",
          "setup",
          `dependency cycle among: ${unresolved.join(", ")}`,
        );
      }

      for (const entry of this.#ordered("registered")) {
        if (this.#stopping) return;

        const blocker = this.#blockingDependency(entry, "setup");
        if (blocker) await this.#fail(entry, "disabled", "setup", blocker);
        else await this.#run(entry, "setup");
      }

      for (const entry of this.#ordered("setup")) {
        if (this.#stopping) return;

        const blocker = this.#blockingDependency(entry, "started");
        if (blocker) await this.#fail(entry, "disabled", "start", blocker);
        else await this.#run(entry, "start");
      }

      this.#phase = "started";
    } catch (error) {
      await this.#shutdown();

      throw error;
    }
  }

  async #shutdown(): Promise<void> {
    if (this.#phase === "stopped") return;

    this.#phase = "stopping";

    for (const name of [...this.#order].reverse()) {
      const entry = this.#entries.get(name)!;
      if (entry.state !== "started" && entry.state !== "setup") continue;

      await this.#stopEntry(entry, entry.state === "started");
      this.#setState(entry, "stopped");
    }

    this.#phase = "stopped";
  }

  /** Aborts the signal, calls stop() if the plugin started, then tears it down. */
  async #stopEntry(entry: Entry, callStop: boolean): Promise<void> {
    entry.controller.abort(new Error("plugin is stopping"));

    if (callStop && entry.plugin.stop) {
      try {
        await withTimeout(() => entry.plugin.stop!(entry.ctx!), this.#timeoutMs);
      } catch (error) {
        entry.error = error;
        this.#log.error(new PluginError(entry.plugin.name, "stop", "stop failed", { cause: error }));
      }
    }

    await this.#teardown(entry);
  }

  async #onHookError(error: PluginError): Promise<void> {
    if (this.#hookErrors === "throw") throw error;

    this.#log.error(error);

    const entry = this.#entries.get(error.plugin);
    if (this.#hookErrors === "disable" && this.#phase === "started" && entry?.state === "started") {
      await this.#disableAtRuntime(entry, error);
    }
  }

  /** Stops a running plugin as failed, and the started plugins that depend on it (directly or not) as disabled. */
  async #disableAtRuntime(culprit: Entry, error: PluginError): Promise<void> {
    const affected = new Set([culprit.plugin.name]);

    // #order lists dependencies first, so one pass collects every transitive dependent.
    for (const name of this.#order) {
      if (this.#entries.get(name)!.plugin.dependsOn?.some((dep) => affected.has(dep))) affected.add(name);
    }

    for (const name of [...this.#order].reverse()) {
      const entry = this.#entries.get(name)!;
      if (!affected.has(name) || entry.state !== "started") continue;

      // State changes first, so a concurrent hook error doesn't stop the same plugin twice.
      if (entry === culprit) {
        entry.reason = `disabled at runtime: ${error.reason}`;
        entry.error = error;
        this.#setState(entry, "failed");
      } else {
        entry.reason = `dependency "${culprit.plugin.name}" is failed`;
        this.#setState(entry, "disabled");
        this.#log.warn(`[${name}] ${entry.reason}`);
      }

      await this.#stopEntry(entry, true);
    }
  }

  *#ordered(state: PluginState): Generator<Entry> {
    for (const name of this.#order) {
      const entry = this.#entries.get(name)!;
      if (entry.state === state) yield entry;
    }
  }

  #blockingDependency(entry: Entry, needed: PluginState): string | undefined {
    for (const dep of entry.plugin.dependsOn ?? []) {
      const target = this.#entries.get(dep);

      if (!target) return `missing dependency "${dep}"`;
      if (target.state !== needed) return `dependency "${dep}" is ${target.state}`;
    }

    return undefined;
  }

  async #run(entry: Entry, phase: "setup" | "start"): Promise<void> {
    // Before the context exists, so ctx.options is the parsed value.
    if (phase === "setup" && entry.plugin.optionsSchema) {
      try {
        entry.options = await parseWith(entry.plugin.optionsSchema, entry.options);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await this.#fail(entry, "failed", "setup", `invalid options: ${detail}`, error);
        return;
      }
    }

    const ctx = (entry.ctx ??= this.#createContext(entry));
    const { plugin } = entry;

    try {
      await withTimeout(
        () => (phase === "setup" ? plugin.setup(ctx) : plugin.start?.(ctx)),
        this.#timeoutMs,
        entry.controller,
      );
    } catch (error) {
      await this.#fail(
        entry,
        "failed",
        phase,
        `${phase} failed: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
      return;
    }

    this.#setState(entry, phase === "setup" ? "setup" : "started");
  }

  /** Tears the plugin down and records why. Under "strict", also throws (and #start shuts everything down). */
  async #fail(
    entry: Entry,
    state: "failed" | "disabled",
    phase: ErrorPhase,
    reason: string,
    error?: unknown,
  ): Promise<void> {
    entry.reason = reason;
    entry.error = error;

    await this.#teardown(entry);
    this.#setState(entry, state);

    const err = new PluginError(entry.plugin.name, phase, reason, error === undefined ? undefined : { cause: error });
    if (this.#failure === "strict") throw err;

    if (state === "failed") this.#log.error(err);
    else this.#log.warn(err.message);
  }

  async #teardown(entry: Entry): Promise<void> {
    if (entry.tornDown) return;
    entry.tornDown = true;

    if (!entry.controller.signal.aborted) entry.controller.abort(new Error("plugin was torn down"));

    for (const dispose of entry.disposers.splice(0).reverse()) {
      try {
        await withTimeout(dispose, this.#timeoutMs);
      } catch (error) {
        this.#log.error(new PluginError(entry.plugin.name, "dispose", "disposer failed", { cause: error }));
      }
    }

    this.hooks.removeOwner(entry.plugin.name);

    for (const [key, service] of this.#services) {
      if (service.owner === entry.plugin.name) this.#services.delete(key);
    }
  }

  #createContext(entry: Entry): PluginContext {
    const { name } = entry.plugin;
    const allowed = new Set([name, HOST, ...(entry.plugin.dependsOn ?? []), ...(entry.plugin.optionalDependsOn ?? [])]);

    const lookup = (key: string) => {
      const service = this.#services.get(key);

      if (service && !allowed.has(service.owner)) {
        throw new PluginError(
          name,
          "service",
          `uses "${key}" from "${service.owner}" without listing "${service.owner}" in dependsOn`,
        );
      }

      return service;
    };

    const tag = `[${this.app.name}:${name}]`;

    return {
      name,
      options: entry.options,
      app: this.app,
      signal: entry.controller.signal,
      log: {
        debug: (...args) => this.#log.debug(tag, ...args),
        info: (...args) => this.#log.info(tag, ...args),
        warn: (...args) => this.#log.warn(tag, ...args),
        error: (...args) => this.#log.error(tag, ...args),
      },
      hooks: this.hooks.scope(name),
      provide: (key, value) => this.#provide(name, key, value),
      use: (key) => {
        const service = lookup(key);
        if (!service) throw new PluginError(name, "service", `service "${key}" is not provided`);

        return service.value as any;
      },
      tryUse: (key) => lookup(key)?.value as any,
      onDispose: (fn) => {
        if (entry.tornDown) throw new PluginError(name, "dispose", "onDispose called after the plugin was torn down");

        entry.disposers.push(fn);
      },
    };
  }

  #provide(owner: string, key: string, value: unknown): void {
    const existing = this.#services.get(key);

    if (existing) {
      throw new PluginError(owner, "service", `service "${key}" is already provided by "${existing.owner}"`);
    }

    this.#services.set(key, { owner, value });
  }

  #add(plugin: Plugin, options: unknown, source: string): void {
    this.#assertPhase("idle", "register plugins");

    if (!isPlugin(plugin)) throw new PluginError(source, "register", "not a valid plugin (expected { name, setup })");

    const existing = this.#entries.get(plugin.name);
    if (existing) throw new PluginError(plugin.name, "register", `already registered (from ${existing.source})`);

    this.#entries.set(plugin.name, newEntry(plugin, options, source));
  }

  #setState(entry: Entry, state: PluginState): void {
    const previous = entry.state;
    entry.state = state;

    for (const listener of this.#listeners) {
      try {
        listener(info(entry), previous);
      } catch (error) {
        this.#log.error("onStateChange listener threw", error);
      }
    }
  }

  #assertPhase(expected: HostPhase, action: string): void {
    if (this.#phase !== expected) throw new Error(`Cannot ${action}: host is ${this.#phase}`);
  }
}

/**
 * Orders plugins so dependencies come first. Ties keep registration order, so the
 * result is deterministic. Dependencies that aren't registered are ignored here
 * (the host reports them); plugins in, or blocked by, a cycle end up in `unresolved`.
 */
function resolveOrder(plugins: readonly Plugin[]): { order: string[]; unresolved: string[] } {
  const names = new Set(plugins.map((p) => p.name));
  const pending = plugins.map((p) => ({
    name: p.name,
    deps: [...(p.dependsOn ?? []), ...(p.optionalDependsOn ?? [])].filter((d) => names.has(d)),
  }));
  const done = new Set<string>();
  const order: string[] = [];

  for (let i = 0; i < pending.length;) {
    if (pending[i].deps.every((d) => done.has(d))) {
      const [node] = pending.splice(i, 1);
      order.push(node.name);
      done.add(node.name);

      i = 0;
    } else {
      i++;
    }
  }

  return { order, unresolved: pending.map((n) => n.name) };
}

/** Rejects after `ms` (and aborts `controller`). The underlying work can't be cancelled, only abandoned. */
async function withTimeout<T>(fn: () => T | Promise<T>, ms: number, controller?: AbortController): Promise<Awaited<T>> {
  if (!(ms > 0) || !Number.isFinite(ms)) return await fn();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new TimeoutError(ms);

      controller?.abort(error);
      reject(error);
    }, ms);
  });

  try {
    return await Promise.race([Promise.resolve().then(fn), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function newEntry(plugin: Plugin, options: unknown, source: string): Entry {
  return {
    plugin,
    options,
    source,
    state: "registered",
    controller: new AbortController(),
    disposers: [],
    tornDown: false,
  };
}

function info(entry: Entry): PluginInfo {
  return {
    name: entry.plugin.name,
    version: entry.plugin.version,
    source: entry.source,
    state: entry.state,
    reason: entry.reason,
    error: entry.error,
  };
}
