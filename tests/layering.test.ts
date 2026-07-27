/**
 * Directory layering guards. These are cheap and catch the two import edges that
 * are easy to reintroduce by reflex and impossible to spot in review:
 *
 *  - src/shared/** must never import from src/client/**. src/shared is consumed
 *    by the Node CLI and the CalDAV server as well as the browser, so a single
 *    edge back into src/client drags Preact/DOM code into those programs.
 *  - src/shared/schemas/** is the worker-safe validation half of the doc-type
 *    plugins (see the WORKER BOUNDARY note in schemas/index.ts). It must never
 *    reach a plugin.tsx or anything else that imports Preact.
 *  - src/client/ui and src/client/worker must not import each other. They run on
 *    different threads; anything both need belongs in src/client/shared (browser
 *    APIs) or src/shared (portable). Type-only edges count — they are invisible
 *    at runtime, so nothing else would ever catch the layering drifting.
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Every module specifier in a file, ignoring bare package names. */
function relativeSpecifiers(file: string): string[] {
  const src = fs.readFileSync(file, 'utf8');
  const re = /(?:\bfrom\s*|\bimport\(\s*|\brequire\(\s*|jest\.mock\(\s*)['"](\.[^'"\n]+)['"]/g;
  return [...src.matchAll(re)].map(m => m[1]);
}

describe('directory layering', () => {
  it('src/shared never imports from src/client', () => {
    const offenders: string[] = [];
    for (const file of walk(path.join(REPO, 'src/shared'))) {
      for (const spec of relativeSpecifiers(file)) {
        const target = path.resolve(path.dirname(file), spec);
        if (target.startsWith(path.join(REPO, 'src/client'))) {
          offenders.push(`${path.relative(REPO, file)} -> ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it.each([
    ['src/client/ui', 'src/client/worker'],
    ['src/client/worker', 'src/client/ui'],
  ])('%s never imports from %s', (fromDir, toDir) => {
    const offenders: string[] = [];
    for (const file of walk(path.join(REPO, fromDir))) {
      for (const spec of relativeSpecifiers(file)) {
        const target = path.resolve(path.dirname(file), spec);
        if (target.startsWith(path.join(REPO, toDir))) {
          offenders.push(`${path.relative(REPO, file)} -> ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('src/shared/schemas never imports Preact or UI code', () => {
    const offenders: string[] = [];
    for (const file of walk(path.join(REPO, 'src/shared/schemas'))) {
      const src = fs.readFileSync(file, 'utf8');
      const re = /\bfrom\s*['"]([^'"\n]+)['"]/g;
      for (const m of src.matchAll(re)) {
        const spec = m[1];
        if (/^preact(\/|$)|^react(-dom)?(\/|$)|^@preact\//.test(spec)) {
          offenders.push(`${path.relative(REPO, file)} -> ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
