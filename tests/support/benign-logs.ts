// Known-benign log lines that some third-party libraries emit via a *raw*
// console.warn we can't gate at the source (see setup-console.ts). Each entry
// matches a specific teardown-race warning; anything not listed here passes
// through untouched, so this stays a narrow allowlist, not a blanket silence.
export const BENIGN_LOG_PATTERNS: RegExp[] = [
  /flush\(\) during shutdown failed/, // [automerge-repo:repo] logger.warn
  /\[SubductionSource\] storeBuiltBatch failed/, // subduction raw console.warn
];

/** True when a console.* call (its arg list) matches a known-benign line. */
export function isBenignLogLine(args: unknown[]): boolean {
  const line = args.map((a) => (typeof a === 'string' ? a : '')).join(' ');
  return BENIGN_LOG_PATTERNS.some((re) => re.test(line));
}
