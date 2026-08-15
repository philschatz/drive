// Known-benign log lines that third-party code emits via a *raw* console call
// we can't gate at the source (see setup-console.ts). Anything not listed here
// passes through untouched, so this stays a narrow allowlist, not a blanket
// silence — a NEW library warning still shows up.
export const BENIGN_LOG_PATTERNS: RegExp[] = [
  /flush\(\) during shutdown failed/, // [automerge-repo:repo] logger.warn
  /\[SubductionSource\] storeBuiltBatch failed/, // subduction raw console.warn
  // jsdom has no navigation, so any component calling window.location.reload()
  // (e.g. StorageSettings' enable-sync flow) trips its virtual console. It is a
  // statement about jsdom's limits, not about our code, and the component is
  // *supposed* to reload — so there is nothing to fix at the call site.
  /Not implemented: navigation \(except hash changes\)/,
];

/** True when a console.* call (its arg list) matches a known-benign line. */
export function isBenignLogLine(args: unknown[]): boolean {
  const line = args.map(errorText).join(' ');
  return BENIGN_LOG_PATTERNS.some((re) => re.test(line));
}

/**
 * The text of one console argument.
 *
 * Errors are duck-typed on a string `message`, NOT `instanceof Error`: jsdom
 * builds its "Not implemented" error inside its own realm, so it has
 * `constructor.name === 'Error'` and `instanceof Error === false`. That whole
 * call carries no string argument at all, so matching only strings would never
 * see it.
 */
function errorText(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a && typeof a === 'object') {
    const { message, stack } = a as { message?: unknown; stack?: unknown };
    if (typeof message === 'string') return message;
    if (typeof stack === 'string') return stack;
  }
  return '';
}
