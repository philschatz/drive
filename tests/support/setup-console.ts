// Some third-party libraries log benign lines via a *raw* console call that we
// can't gate at the source without editing node_modules:
//   [automerge-repo:repo] flush() during shutdown failed   (console.warn)
//   [SubductionSource] storeBuiltBatch failed for …        (console.warn)
//   Error: Not implemented: navigation (except hash changes)  (jsdom, console.error)
//
// This swaps console.warn and console.error at test startup to swallow ONLY
// those specific lines (see benign-logs.ts); everything else passes straight
// through to the real console.
//
// This file is NOT redundant now that src/shared/logger.ts exists — please don't
// delete it on that reasoning. The logger can only gate OUR code. `LOG_LEVEL` in
// jest.config.js silences our debug/info/warn; the lines above come from library
// code that never touches our logger, so interception is the only lever.
//
// Our own expected errors are a different problem with a different answer:
// `error` deliberately still prints (so an UNEXPECTED failure is visible), and a
// test that provokes one claims it locally with captureConsole(['error']) plus an
// assertion — see tests/support/console.ts.
//
// NOTE: the SubductionSource line is a raw console.warn today. A future version
// of the keyhive/subduction stack may route it through a logger instead
// (automerge-repo already exposes setLoggerFactory() for its own logger) — once
// it does, that warning can be gated at the source and its pattern dropped from
// benign-logs.ts.
//
// Installed once per test file (setupFilesAfterEnv), before any test runs, and
// deliberately NOT restored — so output emitted during setup/teardown (repo
// shutdown, worker exit), outside any test body, is filtered too. Set TEST_LOG=1
// to disable the filter and see everything.
import { isBenignLogLine } from './benign-logs';

if (process.env.TEST_LOG !== '1') {
  for (const method of ['warn', 'error'] as const) {
    const real = console[method].bind(console);
    console[method] = (...args: unknown[]): void => {
      if (isBenignLogLine(args)) return;
      real(...args);
    };
  }
}
