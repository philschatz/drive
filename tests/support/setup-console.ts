// Some third-party libraries log benign teardown-race warnings via a *raw*
// console.warn that we can't gate at the source without editing node_modules:
//   [automerge-repo:repo] flush() during shutdown failed
//   [SubductionSource] storeBuiltBatch failed for …
//
// This swaps console.warn at test startup to swallow ONLY those specific lines
// (see benign-logs.ts); every other warning passes straight through to the real
// console. Tests that deliberately drive one of OUR error paths use
// captureConsole() in the test body instead (tests/support/console.ts) — this
// filter is strictly for the un-gateable library noise.
//
// NOTE: the SubductionSource line is a raw console.warn today. A future version
// of the keyhive/subduction stack may route it through a logger instead
// (automerge-repo already exposes setLoggerFactory() for its own logger) — once
// it does, that warning can be gated at the source and its pattern dropped from
// benign-logs.ts.
//
// Installed once per test file (setupFilesAfterEnv), before any test runs, and
// deliberately NOT restored — so warnings emitted during setup/teardown (repo
// shutdown, worker exit), outside any test body, are filtered too. Set
// TEST_LOG=1 to disable the filter and see everything.
import { isBenignLogLine } from './benign-logs';

if (process.env.TEST_LOG !== '1') {
  const realWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]): void => {
    if (isBenignLogLine(args)) return;
    realWarn(...args);
  };
}
