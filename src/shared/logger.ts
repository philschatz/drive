/**
 * Namespaced, level-gated application logger.
 *
 * Every program in this repo shares this module: the browser main thread, the
 * engine Web Worker, the HyperFormula worker, the Node relay / CalDAV / CLI
 * processes, and Jest (both the `server` and `ui` projects). That is why it
 * touches no host API directly:
 *
 *   - **`process` is read through `globalThis`, never as a bare global.** Vite
 *     does not shim `process` in the browser, and tsconfig.client.json declares
 *     only `vite/client` types (no `node`), so a bare `process` reference is a
 *     compile error there. Optional chaining off `globalThis` needs no ambient
 *     declaration and is `undefined` in the browser at runtime. It also dodges
 *     Vite's textual `process.env.NODE_ENV` substitution, which only matches the
 *     literal member expression.
 *   - **`import.meta` is forbidden here.** ts-jest emits CommonJS and cannot
 *     transform it — that is exactly why doc-plugins/datagrid/hf-bridge.ts
 *     cannot mount under jsdom today. Reaching for `import.meta.env.VITE_*`
 *     would break every node test that imports this module. There is a guard for
 *     this in tests/layering.test.ts.
 *   - It lives in `src/shared`, so it must not import from `src/client`
 *     (tests/layering.test.ts) — which is why it knows nothing about the
 *     `debug-enable` setting and only exposes `setLogLevel()` for a host to call.
 *
 * Usage — the `[ns]` tag is the LOGGER's job, never the call site's:
 *
 *   const log = createLogger('engine');
 *   log.warn(`import-backup: skipping ${label}:`, errMsg(err));
 *   // → "[engine] import-backup: skipping foo: boom"
 *
 * Levels, quietest first: silent < error < warn < info < debug. A record emits
 * when the active level is at or above its own. Namespaces are lowercase-kebab
 * (`engine`, `qr-code`) so LOG_NS can name them without case games.
 *
 * Environment (Node/Jest only — absent in the browser, where the host calls
 * setLogLevel() instead):
 *   LOG_LEVEL=debug                  global level (default `info`)
 *   LOG_NS=engine:debug,relay:silent per-namespace overrides
 *
 * Each thread is its own module graph and therefore its own logger state:
 * setLogLevel() on the main thread does not make the engine worker chatty.
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';
/** Every level that actually emits — i.e. every level except `silent`. */
export type EmitLevel = Exclude<LogLevel, 'silent'>;

const RANK: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /**
   * True when a record at `level` would emit. Guard *expensive or fallible*
   * message-building with this — `log.debug(describe(msg))` still runs
   * `describe()` even when debug is off. The relay's per-message formatter
   * (describe-message.ts) decodes CBOR and hashes payloads, so it must not run
   * unless it will actually be printed.
   */
  enabled(level: EmitLevel): boolean;
}

/**
 * Where a record that passed the gate goes. Swappable so a test can assert on
 * log output without spying on the global console (see tests/logger.test.ts).
 */
export type LogSink = (level: EmitLevel, tag: string, args: unknown[]) => void;

const consoleSink: LogSink = (level, tag, args) => {
  // debug → console.log, because DevTools hides console.debug behind its
  // "Verbose" filter. The level gate, not the console method, decides
  // visibility.
  const method = level === 'debug' ? 'log' : level;
  const sink = console[method] as (...a: unknown[]) => void;
  // Merge the tag INTO the first argument when it is a string, so console's
  // format specifiers still find their format string in slot 0 (`'… %d:', n`)
  // and the rendered line stays byte-identical to the inline-`[ns]`-prefix
  // version this replaced.
  if (typeof args[0] === 'string') sink(`${tag} ${args[0]}`, ...args.slice(1));
  else sink(tag, ...args);
};

function isLevel(v: unknown): v is LogLevel {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(RANK, v);
}

/** Read an env var without assuming `process` exists or is typed. See header. */
function env(name: string): string | undefined {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return g.process?.env?.[name];
}

function envLevel(): LogLevel | undefined {
  const raw = env('LOG_LEVEL')?.trim().toLowerCase();
  // An unrecognised value falls back to the default rather than throwing — a
  // typo in a shell should not take the process down.
  return isLevel(raw) ? raw : undefined;
}

/** `LOG_NS=engine:debug,relay:silent` */
function envNamespaceLevels(): Map<string, LogLevel> {
  const out = new Map<string, LogLevel>();
  const raw = env('LOG_NS');
  if (!raw) return out;
  for (const part of raw.split(',')) {
    const [ns, lvl] = part.split(':').map((s) => s.trim().toLowerCase());
    if (ns && isLevel(lvl)) out.set(ns, lvl);
  }
  return out;
}

/**
 * Default when nothing says otherwise: warnings, errors and lifecycle info get
 * through, while the per-message firehoses (`→ send` / `← recv` / the relay's
 * routed messages) are `debug` and stay off — including in production, where
 * they were unconditional before this logger existed. The in-app debug toggle
 * (Settings → debug) turns them back on.
 */
const DEFAULT_LEVEL: LogLevel = 'info';

let globalLevel: LogLevel = envLevel() ?? DEFAULT_LEVEL;
let nsLevels: Map<string, LogLevel> = envNamespaceLevels();
let sink: LogSink = consoleSink;

export function setLogLevel(level: LogLevel): void { globalLevel = level; }
export function getLogLevel(): LogLevel { return globalLevel; }
/** Turn one namespace up (or down) independently of the global level. */
export function setNamespaceLevel(ns: string, level: LogLevel): void { nsLevels.set(ns, level); }
export function setLogSink(next: LogSink | null): void { sink = next ?? consoleSink; }

/** Restore this module's startup state, re-reading the env. For a test afterEach. */
export function resetLogging(): void {
  globalLevel = envLevel() ?? DEFAULT_LEVEL;
  nsLevels = envNamespaceLevels();
  sink = consoleSink;
}

export function createLogger(ns: string): Logger {
  const tag = `[${ns}]`;
  // The level and sink are resolved at CALL time, not here: modules build their
  // logger at import time, which is before any host has had a chance to call
  // setLogLevel() — and before a test can install a sink or a console spy.
  const enabled = (level: EmitLevel): boolean =>
    RANK[nsLevels.get(ns) ?? globalLevel] >= RANK[level];
  const emit = (level: EmitLevel) => (...args: unknown[]): void => {
    if (!enabled(level)) return;
    sink(level, tag, args);
  };
  return {
    debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error'), enabled,
  };
}
