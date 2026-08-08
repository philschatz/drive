/**
 * The pure half of the source inspector.
 *
 * `resolveLevel` is the load-bearing piece: the inspector shows the level the URL
 * names, and three callers hand it a path without knowing the document's shape —
 * the validation panel deep-links to an error's *leaf*, every other editor links
 * to whatever field was focused, and an operations row carries a raw Automerge
 * patch path whose last segment can be a character offset. All of that has to land
 * somewhere sensible rather than on a blank screen.
 */
import {
  collectChangedPaths, escapeString, parseValue, pathFromRest, resolveLevel,
  unescapeString, valueAt, valuePreview, nodeKind, containerSummary,
} from './source-nodes';
import { BLOCK_MARKER } from '../../../shared/rich-text-ops';

const DOC = {
  '@type': 'Calendar',
  name: 'Work',
  events: {
    'ev-1': { title: 'Standup', duration: 15, allDay: false, notes: null },
    'ev-3': { title: 'Review', alerts: [{ trigger: '-PT5M' }] },
  },
  content: `${BLOCK_MARKER}Hello world`,
};

const RICH = new Set(['content']);

describe('resolveLevel', () => {
  it('lists the container a path names', () => {
    expect(resolveLevel(DOC, ['events'], RICH)).toEqual({
      levelPath: ['events'], selectedKey: null, fieldPath: null, missing: false,
    });
    expect(resolveLevel(DOC, ['events', 'ev-1'], RICH).levelPath).toEqual(['events', 'ev-1']);
  });

  it('shows the root for an empty path', () => {
    expect(resolveLevel(DOC, [], RICH)).toEqual({
      levelPath: [], selectedKey: null, fieldPath: null, missing: false,
    });
  });

  it('lands a leaf path on the parent level, pointing at the row', () => {
    // What the validation panel and every editor's "Edit source" link produce.
    expect(resolveLevel(DOC, ['events', 'ev-1', 'title'], RICH)).toEqual({
      levelPath: ['events', 'ev-1'], selectedKey: 'title', fieldPath: null, missing: false,
    });
  });

  it('treats a null leaf as a row, not as a container', () => {
    expect(resolveLevel(DOC, ['events', 'ev-1', 'notes'], RICH)).toEqual({
      levelPath: ['events', 'ev-1'], selectedKey: 'notes', fieldPath: null, missing: false,
    });
  });

  it('drops the character offset an Automerge patch path ends in', () => {
    // A text splice reports ['content', 14]; 14 is a position in the text, not a
    // key, so the field itself is what to show.
    expect(resolveLevel(DOC, ['content', 14], RICH)).toEqual({
      levelPath: [], selectedKey: null, fieldPath: ['content'], missing: false,
    });
  });

  it('gives a marker-carrying string its own screen, and a plain one a row', () => {
    expect(resolveLevel(DOC, ['content'], RICH).fieldPath).toEqual(['content']);
    // The same field with no markers is just a value in the root level.
    expect(resolveLevel(DOC, ['content'], new Set())).toEqual({
      levelPath: [], selectedKey: 'content', fieldPath: null, missing: false,
    });
  });

  it('walks into an array by index', () => {
    expect(resolveLevel(DOC, ['events', 'ev-3', 'alerts'], RICH).levelPath)
      .toEqual(['events', 'ev-3', 'alerts']);
    expect(resolveLevel(DOC, ['events', 'ev-3', 'alerts', 0], RICH).levelPath)
      .toEqual(['events', 'ev-3', 'alerts', 0]);
  });

  it('reports a stale path but still shows the deepest level it reached', () => {
    // A deleted event: the level above it is the useful thing to show.
    expect(resolveLevel(DOC, ['events', 'ev-gone'], RICH)).toEqual({
      levelPath: ['events'], selectedKey: 'ev-gone', fieldPath: null, missing: true,
    });
    // Two missing segments is not a row to point at, only a level to fall back to.
    expect(resolveLevel(DOC, ['nope', 'deeper'], RICH)).toEqual({
      levelPath: [], selectedKey: null, fieldPath: null, missing: true,
    });
  });

  it('never throws on a document that has not loaded', () => {
    expect(resolveLevel(null, ['events', 'ev-1'], RICH).levelPath).toEqual([]);
    expect(resolveLevel(undefined, [], RICH).missing).toBe(false);
  });
});

describe('paths', () => {
  it('decodes a router remainder, coercing array indices to numbers', () => {
    expect(pathFromRest('events/ev-1/title')).toEqual(['events', 'ev-1', 'title']);
    expect(pathFromRest('alerts/0/trigger')).toEqual(['alerts', 0, 'trigger']);
    expect(pathFromRest('a%2Fb/x')).toEqual(['a/b', 'x']);
    expect(pathFromRest(undefined)).toEqual([]);
    expect(pathFromRest('')).toEqual([]);
  });

  it('reads a value out of a document without throwing on a missing segment', () => {
    expect(valueAt(DOC, ['events', 'ev-1', 'duration'])).toBe(15);
    expect(valueAt(DOC, ['events', 'nope', 'deeper'])).toBeUndefined();
    expect(valueAt(DOC, ['name', 'length'])).toBeUndefined();
  });
});

describe('value display', () => {
  it('escapes a block marker so it is visible and typeable', () => {
    // U+FFFC renders as nothing, so it would survive an edit round trip invisibly.
    expect(escapeString(`${BLOCK_MARKER}Hi`)).toBe('\\uFFFCHi');
    expect(unescapeString('\\uFFFCHi')).toBe(`${BLOCK_MARKER}Hi`);
    const gnarly = `a\\b\nc\t${BLOCK_MARKER}`;
    expect(unescapeString(escapeString(gnarly))).toBe(gnarly);
  });

  it('coerces a typed value at its apparent type', () => {
    expect(parseValue('null')).toBeNull();
    expect(parseValue('true')).toBe(true);
    expect(parseValue('false')).toBe(false);
    expect(parseValue('42')).toBe(42);
    expect(parseValue('-1.5')).toBe(-1.5);
    expect(parseValue('Standup')).toBe('Standup');
    expect(parseValue('')).toBe('');
    expect(parseValue('\\uFFFC')).toBe(BLOCK_MARKER);
  });

  it('never lets a long value be the reason a row scrolls sideways', () => {
    const preview = valuePreview('x'.repeat(500));
    expect(preview.length).toBeLessThan(90);
    // Still a closed string literal — the ellipsis goes inside the quotes.
    expect(preview.endsWith('…"')).toBe(true);
  });

  it('summarises a container by how much is inside it', () => {
    expect(containerSummary({ a: 1 })).toBe('1 key');
    expect(containerSummary({ a: 1, b: 2 })).toBe('2 keys');
    expect(containerSummary([1])).toBe('1 item');
    expect(containerSummary([])).toBe('0 items');
  });

  it('names a marker-carrying string as rich text, so it gets the ¶ glyph', () => {
    expect(nodeKind('hi')).toBe('string');
    expect(nodeKind('hi', true)).toBe('richtext');
    expect(nodeKind(null)).toBe('null');
    expect(nodeKind([])).toBe('array');
    expect(nodeKind({})).toBe('object');
    expect(nodeKind(1)).toBe('number');
    expect(nodeKind(false)).toBe('boolean');
  });
});

describe('collectChangedPaths', () => {
  it('collects the ancestors too, so a deep edit flashes on the row leading to it', () => {
    // A deep clone, like the fresh snapshot the worker delivers: EVERY object here
    // is a new reference, and only one value actually differs.
    const next = JSON.parse(JSON.stringify(DOC));
    next.events['ev-1'].title = 'Standup ✱';
    const out = new Set<string>();
    collectChangedPaths(DOC, next, [], out);
    // The inspector shows one level at a time, so 'events' is the only row that
    // can carry this change when you are standing at the root.
    expect(out.has('events')).toBe(true);
    expect(out.has('events/ev-1')).toBe(true);
    expect(out.has('events/ev-1/title')).toBe(true);
    // An untouched sibling must NOT flash just because its identity is new —
    // otherwise every row of every level flashes on every keystroke.
    expect(out.has('events/ev-3')).toBe(false);
    expect(out.has('name')).toBe(false);
  });

  it('says nothing when nothing changed', () => {
    const out = new Set<string>();
    collectChangedPaths(DOC, DOC, [], out);
    expect(out.size).toBe(0);
  });
});
