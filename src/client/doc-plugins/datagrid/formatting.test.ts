import { formatToCss, resolveConditionalFormat, buildIndexMaps } from './formatting';
import type { ConditionalFormatRule } from '../../../shared/schemas/datagrid';

// ── M3: cell background uses backgroundColor, not the `background` shorthand ──
// The `background` shorthand accepts url(...), which the browser would fetch from
// hostile doc content. backgroundColor does not, so a url() value is inert.

describe('formatToCss background (M3 defense-in-depth)', () => {
  it('writes bgColor to backgroundColor, never the background shorthand', () => {
    const css = formatToCss({ bgColor: '#ff0000' })!;
    expect(css.backgroundColor).toBe('#ff0000');
    expect('background' in css).toBe(false);
  });

  it('a hostile url() bgColor lands in backgroundColor (no fetch surface)', () => {
    const css = formatToCss({ bgColor: 'url(https://evil.example/track.png)' })!;
    // Never in a `background` shorthand — where url() would trigger a fetch.
    expect('background' in css).toBe(false);
    expect(css.backgroundColor).toBe('url(https://evil.example/track.png)');
  });

  it('still emits other style properties', () => {
    const css = formatToCss({ bold: true, textColor: '#123456', bgColor: '#eeeeee' })!;
    expect(css.fontWeight).toBe('bold');
    expect(css.color).toBe('#123456');
    expect(css.backgroundColor).toBe('#eeeeee');
  });
});

// ── Fold-in perf: conditional format resolution via precomputed index maps ──

describe('resolveConditionalFormat with precomputed index maps', () => {
  const rules: Record<string, ConditionalFormatRule> = {
    rule1: {
      index: 1,
      ranges: { rg: { rangeRowStart: 'r0', rangeRowEnd: 'r0', rangeColStart: 'c0', rangeColEnd: 'c0' } },
      conditionType: 'gt',
      conditionValue: '5',
      format: { bgColor: '#00ff00' },
    },
  };
  const { rowIdxMap, colIdxMap } = buildIndexMaps(['r0', 'r1'], ['c0', 'c1']);

  it('matches a cell in-range that satisfies the condition', () => {
    expect(resolveConditionalFormat(rules, 'r0', 'c0', '10', rowIdxMap, colIdxMap, null))
      .toEqual({ bgColor: '#00ff00' });
  });

  it('does not match a cell outside the rule range', () => {
    expect(resolveConditionalFormat(rules, 'r1', 'c0', '10', rowIdxMap, colIdxMap, null))
      .toBeUndefined();
  });

  it('does not match when the condition is false', () => {
    expect(resolveConditionalFormat(rules, 'r0', 'c0', '3', rowIdxMap, colIdxMap, null))
      .toBeUndefined();
  });

  it('returns undefined for an unknown cell id', () => {
    expect(resolveConditionalFormat(rules, 'gone', 'c0', '10', rowIdxMap, colIdxMap, null))
      .toBeUndefined();
  });
});
