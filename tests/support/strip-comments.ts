/**
 * Blank out comments in TS/TSX source while preserving every line break, so a
 * source-walking guard can report accurate line numbers and never trip over its
 * own documentation.
 *
 * Both convention guards need this: tests/no-raw-console.test.ts must not flag
 * the comment in cli.ts explaining why the stdout redirect catches libraries that
 * bound `console.log`, and tests/layering.test.ts must not flag the JSDoc in
 * relative-dates.ts mentioning `import.meta.glob` — or logger.ts's own header,
 * which explains at length why `import.meta` is forbidden there.
 *
 * Not a full tokenizer. It tracks the three string forms, both comment forms, and
 * treats a backslash as a two-character atom everywhere — which is what keeps a
 * regex literal like `/\/\//` from reading as the start of a line comment. Good
 * enough for a lint rule; a mis-parse shows up as a loud, obvious test failure.
 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  type State = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';
  let state: State = 'code';

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (state === 'code') {
      if (c === '\\') { out += c + (next ?? ''); i += 2; continue; }
      if (c === '/' && next === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && next === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") state = 'single';
      else if (c === '"') state = 'double';
      else if (c === '`') state = 'template';
      out += c; i++; continue;
    }

    if (state === 'line') {
      // Keep the newline so line numbers stay aligned.
      if (c === '\n') { state = 'code'; out += c; } else out += ' ';
      i++; continue;
    }

    if (state === 'block') {
      if (c === '*' && next === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? c : ' ';
      i++; continue;
    }

    // Inside a string/template: copy through, honouring escapes.
    if (c === '\\') { out += c + (next ?? ''); i += 2; continue; }
    if ((state === 'single' && c === "'")
      || (state === 'double' && c === '"')
      || (state === 'template' && c === '`')) state = 'code';
    out += c; i++;
  }
  return out;
}
