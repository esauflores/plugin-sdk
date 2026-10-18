import { parseWith, PluginError, type StandardSchemaV1 } from "./types.ts";

export type HookFn = (...args: any[]) => unknown;
export type HookName<H> = keyof H & string;
type Fn<H, K extends keyof H> = H[K] extends HookFn ? H[K] : never;
type Args<H, K extends keyof H> = H[K] extends (...args: infer A) => any ? A : never[];
type Result<H, K extends keyof H> = H[K] extends (...args: any[]) => infer R ? Awaited<R> : never;

/** Per hook, a schema for the values handlers return (checked by `waterfall` and `bail`). */
export type HookSchemas<H> = {
  [K in HookName<H>]?: StandardSchemaV1<unknown, Exclude<Result<H, K>, undefined | void>>;
};

/** "pre" handlers run first, then "normal" (the default), then "post"; registration order within each. */
export type HookOrder = "pre" | "normal" | "post";

export interface HookOptions {
  order?: HookOrder;
}

export type HookStyle = "call" | "parallel" | "waterfall" | "bail";

/** Observes every hook call on the host's bus: for tracing, metrics, finding slow plugins. */
export interface HookInterceptor {
  /** A hook was called, before any handler runs. */
  call?(event: { hook: string; style: HookStyle; args: readonly unknown[] }): void;
  /**
   * One handler finished. `plugin` is undefined for the app's own handlers; `ms` excludes
   * error handling; `error` is the PluginError if it threw or returned an invalid value.
   */
  handler?(event: { hook: string; plugin: string | undefined; ms: number; error?: unknown }): void;
}

export interface Hooks<H extends object> {
  /** Returns a function that removes the handler. */
  on<K extends HookName<H>>(name: K, fn: Fn<H, K>, options?: HookOptions): () => void;
  /** Runs handlers one after another, in order. */
  call<K extends HookName<H>>(name: K, ...args: Args<H, K>): Promise<void>;
  /** Runs all handlers concurrently. */
  parallel<K extends HookName<H>>(name: K, ...args: Args<H, K>): Promise<void>;
  /**
   * Each handler receives the previous one's result as its first argument; returning undefined keeps the value.
   * Results are checked against the hook's schema, if it has one.
   */
  waterfall<K extends HookName<H>>(name: K, ...args: Args<H, K>): Promise<Args<H, K>[0]>;
  /** Returns the first result that is not undefined, skipping the remaining handlers. Checked like `waterfall`. */
  bail<K extends HookName<H>>(
    name: K,
    ...args: Args<H, K>
  ): Promise<Exclude<Result<H, K>, undefined | void> | undefined>;
  count(name: HookName<H>): number;
}

interface Handler {
  fn: HookFn;
  owner?: string;
  rank: number;
}

const RANKS: Record<HookOrder, number> = { pre: 0, normal: 1, post: 2 };

/**
 * Called when a plugin's handler throws or returns an invalid value. Rethrow to make the hook
 * call reject; return to skip that handler and continue. App handlers (no owner) always rethrow.
 */
export type HookErrorHandler = (error: PluginError) => void | Promise<void>;

export class HookBus<H extends object = any> implements Hooks<H> {
  #handlers = new Map<string, Handler[]>();
  readonly #schemas: HookSchemas<H>;
  readonly #onError?: HookErrorHandler;
  #interceptors: readonly HookInterceptor[] = [];

  constructor(schemas: HookSchemas<H> = {}, onError?: HookErrorHandler) {
    this.#schemas = schemas;
    this.#onError = onError;
  }

  on<K extends HookName<H>>(name: K, fn: Fn<H, K>, options?: HookOptions): () => void {
    return this.#on(name, fn, undefined, options);
  }

  /**
   * Adds an observer of every hook call; returns a function that removes it. Host-only: the
   * scoped view plugins get has no `intercept`. Errors thrown by an interceptor propagate.
   */
  intercept(interceptor: HookInterceptor): () => void {
    this.#interceptors = [...this.#interceptors, interceptor];

    return () => {
      this.#interceptors = this.#interceptors.filter((i) => i !== interceptor);
    };
  }

  /** A view whose `on` tags handlers with `owner`, so `removeOwner` can drop them all. */
  scope(owner: string): Hooks<H> {
    return {
      on: (name, fn, options) => this.#on(name, fn, owner, options),
      call: (name, ...args) => this.call(name, ...args),
      parallel: (name, ...args) => this.parallel(name, ...args),
      waterfall: (name, ...args) => this.waterfall(name, ...args),
      bail: (name, ...args) => this.bail(name, ...args),
      count: (name) => this.count(name),
    };
  }

  removeOwner(owner: string): void {
    for (const [name, list] of this.#handlers) {
      this.#handlers.set(
        name,
        list.filter((h) => h.owner !== owner),
      );
    }
  }

  count(name: HookName<H>): number {
    return this.#handlers.get(name)?.length ?? 0;
  }

  async call<K extends HookName<H>>(name: K, ...args: Args<H, K>): Promise<void> {
    this.#notifyCall(name, "call", args);

    for (const h of this.#snapshot(name)) await this.#handle(h, name, args, false);
  }

  async parallel<K extends HookName<H>>(name: K, ...args: Args<H, K>): Promise<void> {
    this.#notifyCall(name, "parallel", args);

    await Promise.all(this.#snapshot(name).map((h) => this.#handle(h, name, args, false)));
  }

  async waterfall<K extends HookName<H>>(name: K, ...args: Args<H, K>): Promise<Args<H, K>[0]> {
    this.#notifyCall(name, "waterfall", args);

    let [value, ...rest] = args;

    for (const h of this.#snapshot(name)) {
      const next = await this.#handle(h, name, [value, ...rest], true);
      if (next?.value !== undefined) value = next.value;
    }

    return value;
  }

  async bail<K extends HookName<H>>(
    name: K,
    ...args: Args<H, K>
  ): Promise<Exclude<Result<H, K>, undefined | void> | undefined> {
    this.#notifyCall(name, "bail", args);

    for (const h of this.#snapshot(name)) {
      const result = await this.#handle(h, name, args, true);
      if (result?.value !== undefined) return result.value as Exclude<Result<H, K>, undefined | void>;
    }

    return undefined;
  }

  #on(name: string, fn: HookFn, owner: string | undefined, options: HookOptions = {}): () => void {
    if (typeof fn !== "function") throw new TypeError(`Hook handler for "${name}" must be a function`);

    const rank = RANKS[options.order ?? "normal"];
    if (rank === undefined) throw new TypeError(`Hook order must be "pre", "normal" or "post", got "${options.order}"`);

    // Insert after the last handler of the same or an earlier bucket.
    const handler: Handler = { fn, owner, rank };
    const list = this.#handlers.get(name) ?? [];
    const at = list.findIndex((h) => h.rank > rank);
    this.#handlers.set(name, at === -1 ? [...list, handler] : [...list.slice(0, at), handler, ...list.slice(at)]);

    return () => {
      const list = this.#handlers.get(name);
      if (list)
        this.#handlers.set(
          name,
          list.filter((h) => h !== handler),
        );
    };
  }

  // Lists are replaced, never mutated, so handlers added mid-emit don't run in that emit.
  // Handlers removed mid-emit (e.g. their plugin was disabled) are skipped by #handle.
  #snapshot(name: string): readonly Handler[] {
    return this.#handlers.get(name) ?? [];
  }

  /** Runs one handler (and checks its result); `undefined` means it was skipped or its error was handled. */
  async #handle(h: Handler, name: string, args: unknown[], checked: boolean): Promise<{ value: unknown } | undefined> {
    if (!this.#handlers.get(name)?.includes(h)) return undefined;

    const startedAt = performance.now();
    let result: { value: unknown };

    try {
      const value = await this.#invoke(h, name, args);

      result = { value: checked && value !== undefined ? await this.#check(h, name, value) : value };
    } catch (error) {
      this.#notifyHandler(name, h, startedAt, error);

      if (!this.#onError || h.owner === undefined || !(error instanceof PluginError)) throw error;

      await this.#onError(error);

      return undefined;
    }

    this.#notifyHandler(name, h, startedAt);

    return result;
  }

  #notifyCall(hook: string, style: HookStyle, args: readonly unknown[]): void {
    for (const interceptor of this.#interceptors) interceptor.call?.({ hook, style, args });
  }

  #notifyHandler(hook: string, h: Handler, startedAt: number, error?: unknown): void {
    if (this.#interceptors.length === 0) return;

    const event = {
      hook,
      plugin: h.owner,
      ms: performance.now() - startedAt,
      ...(error === undefined ? {} : { error }),
    };
    for (const interceptor of this.#interceptors) interceptor.handler?.(event);
  }

  async #invoke(h: Handler, name: string, args: unknown[]): Promise<unknown> {
    try {
      return await h.fn(...args);
    } catch (cause) {
      if (cause instanceof PluginError && cause.phase === "hook") throw cause;

      throw new PluginError(h.owner ?? "<host>", "hook", `handler for "${name}" threw`, { cause });
    }
  }

  async #check(h: Handler, name: string, value: unknown): Promise<any> {
    const schema = this.#schemas[name as HookName<H>];
    if (!schema) return value;

    try {
      return await parseWith(schema, value);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);

      throw new PluginError(h.owner ?? "<host>", "hook", `handler for "${name}" returned an invalid value: ${detail}`, {
        cause,
      });
    }
  }
}
