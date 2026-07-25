type Method = 'log' | 'info' | 'warn' | 'error' | 'debug';

/**
 * Swallow (collect) console output from a test that deliberately drives an
 * error/warning path, so expected noise doesn't bury genuine failures in the
 * suite output. Returns the collected records plus a `restore()`; call
 * `restore()` once the expected output has been produced (or pair with
 * `afterEach(() => jest.restoreAllMocks())`) so the spy never leaks into an
 * adjacent test.
 *
 * This is for OUR code-under-test warnings. Un-gateable third-party teardown
 * noise is filtered globally in tests/support/setup-console.ts instead.
 */
export function captureConsole(methods: Method[] = ['warn', 'error']) {
  const records: { method: Method; args: unknown[] }[] = [];
  const spies = methods.map((m) =>
    jest.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      records.push({ method: m, args });
    }),
  );
  return {
    records,
    /** Rendered "arg arg" strings, available if a caller wants to inspect them. */
    messages: () => records.map((r) => r.args.map(String).join(' ')),
    restore: () => spies.forEach((s) => s.mockRestore()),
  };
}
