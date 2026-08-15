type Method = 'log' | 'info' | 'warn' | 'error' | 'debug';

/**
 * Claim the console output a test *deliberately* provokes, so expected noise
 * doesn't bury a genuine failure in the suite output.
 *
 * In practice this means `console.error`, the default. App logging goes through
 * src/shared/logger.ts, and `jest.config.js` pins the level to `error` — so
 * debug/info/warn from our own code is already gated off globally and needs no
 * per-test handling. `error` is deliberately left flowing so an *unexpected*
 * failure still shows up; that is exactly the case this helper exists to
 * distinguish from an expected one.
 *
 * Assert on what you captured — don't just swallow it. A silent capture also
 * passes when the error stops happening, which is precisely the regression you
 * wanted to know about:
 *
 *   const con = captureConsole();
 *   // … drive the failure …
 *   con.restore();
 *   expect(con.messages().join('\n')).toMatch(/Automerge worker error/);
 *
 * Call `restore()` once the expected output has been produced (or pair with
 * `afterEach(() => jest.restoreAllMocks())`) so the spy never leaks into an
 * adjacent test.
 *
 * This is for OUR code-under-test. Un-gateable third-party noise is filtered
 * globally in tests/support/setup-console.ts instead.
 */
export function captureConsole(methods: Method[] = ['error']) {
  const records: { method: Method; args: unknown[] }[] = [];
  const spies = methods.map((m) =>
    jest.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      records.push({ method: m, args });
    }),
  );
  return {
    records,
    /** Rendered "arg arg" strings — what you assert against. */
    messages: () => records.map((r) => r.args.map(String).join(' ')),
    restore: () => spies.forEach((s) => s.mockRestore()),
  };
}
