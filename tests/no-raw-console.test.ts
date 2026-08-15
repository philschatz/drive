// App code logs through src/shared/logger.ts, never bare console.*. Bare
// console is for temporary local debugging only — it can't be levelled, so it
// reappears in every `jest --verbose` run and in production.
//
// There is no ESLint/Biome/oxlint in this repo, so this test IS the lint rule.
// Same source-walking shape as tests/layering.test.ts.
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { stripComments } from './support/strip-comments';

const SRC = join(__dirname, '..', 'src');

/**
 * The only places a raw console reference is correct. Each one intercepts or
 * implements console itself, so routing it through the logger is impossible or
 * circular.
 */
const ALLOWED = new Set([
  // Implements the logger's console sink.
  'shared/logger.ts',
  // Patches console.log/debug/info to drop the third-party keyhive bridge's
  // firehose ([AMRepoKeyhive], [Streaming]) — library output never reaches our
  // logger, so intercepting the real console is the only lever.
  'client/worker/automerge-worker.ts',
]);

/** Playwright specs forward the *page's* console to the runner; not app code. */
const SKIP_DIRS = new Set(['tests-pw']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.d\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('logging convention', () => {
  it('no app source file calls console.* directly', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).split(/[\\/]/).join('/');
      // A test is not app code: it may log its own diagnostics, and it may spy
      // on console to claim an expected error.
      if (/\.test\.tsx?$/.test(rel) || ALLOWED.has(rel)) continue;
      // Comments stripped: several files legitimately *discuss* console (cli.ts's
      // note on why redirecting the stream catches libraries that bound
      // console.log at import).
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const [i, line] of src.split('\n').entries()) {
        // Match a call or an assignment, so patching console also trips this.
        if (/\bconsole\s*\.\s*(log|info|warn|error|debug|trace|table|group)\b|\bconsole\s*\[/.test(line)) {
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
