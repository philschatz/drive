// Contract tests for src/shared/logger.ts.
//
// The most valuable assertion here is the first one: under the test runner the
// level is `error`, which is what keeps `jest --verbose` output down to
// assertions and failures. If someone drops the LOG_LEVEL line from
// jest.config.js, this fails rather than the suite quietly going noisy again.
import {
  createLogger, getLogLevel, resetLogging, setLogLevel, setLogSink, setNamespaceLevel,
  type EmitLevel, type LogLevel,
} from '../src/shared/logger';

type Record_ = { level: EmitLevel; tag: string; args: unknown[] };

/** Collect emitted records instead of writing to console. */
function capture(): Record_[] {
  const records: Record_[] = [];
  setLogSink((level, tag, args) => { records.push({ level, tag, args }); });
  return records;
}

const ALL: EmitLevel[] = ['debug', 'info', 'warn', 'error'];
/** Call every method on `log`, so a test can assert which ones got through. */
function emitAll(log: ReturnType<typeof createLogger>): void {
  for (const m of ALL) log[m]('x');
}

afterEach(() => { resetLogging(); });

describe('logger', () => {
  it('is at `error` under the test runner (the suite-is-quiet contract)', () => {
    expect(getLogLevel()).toBe('error');
    expect(process.env.LOG_LEVEL).toBe('error'); // set in jest.config.js
  });

  it.each([
    ['silent', []],
    ['error', ['error']],
    ['warn', ['warn', 'error']],
    ['info', ['info', 'warn', 'error']],
    ['debug', ['debug', 'info', 'warn', 'error']],
  ] as [LogLevel, EmitLevel[]][])('at %s, exactly %p emit', (level, expected) => {
    const records = capture();
    setLogLevel(level);
    emitAll(createLogger('engine'));
    expect(records.map((r) => r.level).sort()).toEqual([...expected].sort());
  });

  it('passes the tag separately and never stringifies args', () => {
    const records = capture();
    setLogLevel('debug');
    const err = new Error('boom');
    const obj = { a: 1 };
    createLogger('engine').warn('failed:', err, obj);
    expect(records).toHaveLength(1);
    expect(records[0].tag).toBe('[engine]');
    // Identity, not equality: a consumer must be able to inspect the real value.
    expect(records[0].args[1]).toBe(err);
    expect(records[0].args[2]).toBe(obj);
  });

  it('resolves the level at call time, not at createLogger time', () => {
    const records = capture();
    // Built while quiet — every migrated module builds its logger at import,
    // long before a host calls setLogLevel().
    const log = createLogger('engine');
    log.debug('dropped');
    setLogLevel('debug');
    log.debug('kept');
    expect(records.map((r) => r.args[0])).toEqual(['kept']);
  });

  it('resolves the sink at call time, so a spy installed later still sees output', () => {
    setLogLevel('warn');
    const log = createLogger('engine');
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    log.warn('after the spy');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  describe('enabled()', () => {
    it('reports what would emit, so callers can skip expensive formatting', () => {
      const log = createLogger('relay');
      setLogLevel('warn');
      expect(ALL.map((l) => log.enabled(l))).toEqual([false, false, true, true]);
      setLogLevel('debug');
      expect(ALL.every((l) => log.enabled(l))).toBe(true);
      setLogLevel('silent');
      expect(ALL.some((l) => log.enabled(l))).toBe(false);
    });

    it('honours a namespace override', () => {
      setLogLevel('silent');
      setNamespaceLevel('relay', 'debug');
      expect(createLogger('relay').enabled('debug')).toBe(true);
      expect(createLogger('engine').enabled('debug')).toBe(false);
    });
  });

  describe('namespace overrides', () => {
    it('turns one namespace up while the global stays quiet', () => {
      const records = capture();
      setLogLevel('silent');
      setNamespaceLevel('engine', 'debug');
      emitAll(createLogger('engine'));
      emitAll(createLogger('kh'));
      expect(records.every((r) => r.tag === '[engine]')).toBe(true);
      expect(records).toHaveLength(4);
    });

    it('turns one namespace down while the global stays loud', () => {
      const records = capture();
      setLogLevel('debug');
      setNamespaceLevel('kh', 'silent');
      emitAll(createLogger('engine'));
      emitAll(createLogger('kh'));
      expect(records.every((r) => r.tag === '[engine]')).toBe(true);
      expect(records).toHaveLength(4);
    });
  });

  describe('console rendering', () => {
    it('merges the tag into args[0] so %d format specifiers still work', () => {
      // qr-code.tsx and worker-client.ts both relied on args[0] being the format
      // string; prepending the tag as a separate argument would break them.
      setLogLevel('warn');
      const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      createLogger('main').warn('query-result error subId=%d:', 7);
      expect(spy).toHaveBeenCalledWith('[main] query-result error subId=%d:', 7);
      spy.mockRestore();
    });

    it('passes the tag as its own argument when args[0] is not a string', () => {
      setLogLevel('warn');
      const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const err = new Error('boom');
      createLogger('main').warn(err);
      expect(spy).toHaveBeenCalledWith('[main]', err);
      spy.mockRestore();
    });

    it('routes debug to console.log, since DevTools hides console.debug', () => {
      setLogLevel('debug');
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});
      const debug = jest.spyOn(console, 'debug').mockImplementation(() => {});
      createLogger('engine').debug('trace');
      expect(log).toHaveBeenCalledWith('[engine] trace');
      expect(debug).not.toHaveBeenCalled();
      log.mockRestore();
      debug.mockRestore();
    });
  });

  describe('environment', () => {
    /** resetLogging() re-reads the env, so mutate + reset to test parsing. */
    function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
      const saved: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(vars)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      try { resetLogging(); fn(); } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
        resetLogging();
      }
    }

    it('seeds the level from LOG_LEVEL', () => {
      withEnv({ LOG_LEVEL: 'debug' }, () => { expect(getLogLevel()).toBe('debug'); });
    });

    it('falls back to the default on a bogus LOG_LEVEL instead of throwing', () => {
      withEnv({ LOG_LEVEL: 'chatty' }, () => { expect(getLogLevel()).toBe('info'); });
    });

    it('parses LOG_NS, ignoring malformed entries', () => {
      withEnv({ LOG_LEVEL: 'silent', LOG_NS: 'engine:debug, kh:nonsense, :warn, relay' }, () => {
        const records = capture();
        emitAll(createLogger('engine'));  // override → all four
        emitAll(createLogger('kh'));      // bad level → falls back to global `silent`
        emitAll(createLogger('relay'));   // no level → same
        expect(records).toHaveLength(4);
        expect(records.every((r) => r.tag === '[engine]')).toBe(true);
      });
    });
  });
});
