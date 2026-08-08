import { validateDocument, type MarkerField } from '.';
import type { RichTextSpan } from '../rich-text-ops';

const doc = { '@type': 'Sentences', name: 'Notes', content: '￼Hello￼world' };

/** `content`'s markers, as the engine reads them out of Automerge. */
const content = (spans: RichTextSpan[]): MarkerField[] => [{ path: ['content'], spans }];
const text = (value: string, marks?: Record<string, unknown>): RichTextSpan =>
  marks ? { type: 'text', value, marks } : { type: 'text', value };
const block = (type: string, attrs: Record<string, unknown> = {}): RichTextSpan =>
  ({ type: 'block', value: { type, parents: [], attrs } });

const href = JSON.stringify({ href: 'https://example.com' });

describe('Document schema', () => {
  it('accepts a valid document (block markers are plain chars in JSON)', () => {
    expect(validateDocument(doc)).toEqual([]);
    expect(validateDocument({ '@type': 'Sentences', name: 'Empty', content: '' })).toEqual([]);
  });

  it('rejects missing or mistyped fields', () => {
    expect(validateDocument({ '@type': 'Sentences', content: '' })).not.toEqual([]);
    expect(validateDocument({ '@type': 'Sentences', name: 'X', content: 42 })).not.toEqual([]);
    expect(validateDocument({ '@type': 'Sentences', name: 'X' })).not.toEqual([]);
  });
});

describe('Sentences marker validation', () => {
  it('accepts the declared vocabulary', () => {
    expect(validateDocument(doc, content([
      block('heading', { level: 1 }),
      text('Hello', { strong: true, em: true }),
      block('paragraph'),
      text('world', { link: href }),
    ]))).toEqual([]);
  });

  it('accepts every declared block type', () => {
    const spans = ['paragraph', 'unordered-list-item', 'ordered-list-item', 'blockquote', 'divider']
      .map(t => block(t));
    expect(validateDocument(doc, content(spans))).toEqual([]);
  });

  it('rejects an unknown mark name', () => {
    const errors = validateDocument(doc, content([text('Hello', { highlight: 'yellow' })]));
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toEqual(['content']);
    expect(errors[0].message).toMatch(/Unknown mark "highlight" at \[0, 5\)/);
    expect(errors[0].message).toMatch(/expected one of: strong, em, link/);
    expect(errors[0].kind).toBeUndefined(); // a schema error, not a warning
  });

  it('rejects an unknown block type', () => {
    const errors = validateDocument(doc, content([block('code', { language: 'ts' })]));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/Unknown block type "code" at 0/);
  });

  it('rejects a link whose value is not JSON', () => {
    const errors = validateDocument(doc, content([text('Hello', { link: 'https://example.com' })]));
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toEqual(['content', 'link']);
    expect(errors[0].message).toMatch(/Expected a JSON string/);
  });

  it('rejects a link whose parsed object has no href', () => {
    const errors = validateDocument(doc, content([text('Hello', { link: JSON.stringify({ url: 'x' }) })]));
    expect(errors.map(e => e.message)).toEqual(
      expect.arrayContaining([expect.stringMatching(/Required value is missing/)]),
    );
    expect(errors.some(e => e.path.join('/') === 'content/link/href')).toBe(true);
  });

  it('rejects a non-boolean strong value', () => {
    const errors = validateDocument(doc, content([text('Hello', { strong: 'purple' })]));
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toEqual(['content', 'strong']);
    expect(errors[0].message).toMatch(/Expected boolean, got string/);
  });

  it('rejects an out-of-range heading level', () => {
    const errors = validateDocument(doc, content([block('heading', { level: 9 })]));
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toEqual(['content', 'heading', 'level']);
    expect(errors[0].message).toMatch(/exceeds maximum 6/);
  });

  it('warns rather than errors for markers on an undeclared field', () => {
    const errors = validateDocument(doc, [{ path: ['name'], spans: [text('Notes', { strong: true })] }]);
    expect(errors).toHaveLength(1);
    expect(errors[0].kind).toBe('warning');
    expect(errors[0].path).toEqual(['name']);
    expect(errors[0].message).toMatch(/does not declare richText/);
  });

  it('skips marker validation entirely when no marker data is supplied', () => {
    expect(validateDocument(doc)).toEqual([]);
  });

  it('reports a flattened field, whose ￼ are characters rather than markers', () => {
    // What a scalar `doc.content = text` write leaves behind: the projection is
    // byte-identical to the healthy document above, so only the spans can tell.
    const errors = validateDocument(doc, content([text('￼Hello￼world')]));
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toEqual(['content']);
    expect(errors[0].message).toMatch(/2 literal U\+FFFC characters \(at 0, 6\)/);
    expect(errors[0].message).toMatch(/rich text was flattened/);
  });

  it('does not report a healthy field that legitimately has block markers', () => {
    expect(validateDocument(doc, content([
      block('paragraph'), text('Hello'), block('paragraph'), text('world'),
    ]))).toEqual([]);
  });
});
