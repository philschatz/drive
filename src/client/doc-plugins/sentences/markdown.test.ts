import type { RichTextSpan } from '../../../shared/rich-text-ops';
import { markdownToSpans, spansToMarkdown } from './markdown';

const block = (type: string, parents: string[] = [], attrs: Record<string, unknown> = {}): RichTextSpan =>
  ({ type: 'block', value: { type, parents, attrs } });
const text = (value: string, marks?: Record<string, unknown>): RichTextSpan =>
  marks ? { type: 'text', value, marks } : { type: 'text', value };

describe('spansToMarkdown', () => {
  it('serializes headings, paragraphs and dividers', () => {
    const md = spansToMarkdown([
      block('heading', [], { level: 1 }), text('Title'),
      block('paragraph'), text('Body text.'),
      block('divider'),
      block('paragraph'), text('After.'),
    ]);
    expect(md).toBe('# Title\n\nBody text.\n\n---\n\nAfter.');
  });

  it('serializes inline marks with proper nesting', () => {
    const md = spansToMarkdown([
      block('paragraph'),
      text('plain '),
      text('bold', { strong: true }),
      text(' and '),
      text('both', { strong: true, em: true }),
    ]);
    expect(md).toBe('plain **bold** and ***both***');
  });

  it('serializes links, including formatted link text', () => {
    const md = spansToMarkdown([
      block('paragraph'),
      text('see '),
      text('the docs', { link: JSON.stringify({ href: 'https://example.com' }) }),
    ]);
    expect(md).toBe('see [the docs](https://example.com)');
  });

  it('serializes nested lists with indentation and numbering', () => {
    const md = spansToMarkdown([
      block('unordered-list-item'), text('one'),
      block('unordered-list-item', ['unordered-list-item']), text('one.a'),
      block('ordered-list-item'), text('first'),
      block('ordered-list-item'), text('second'),
    ]);
    expect(md).toBe('- one\n  - one.a\n1. first\n2. second');
  });

  it('serializes consecutive quote lines tightly', () => {
    const md = spansToMarkdown([
      block('blockquote'), text('line one'),
      block('blockquote'), text('line two'),
    ]);
    expect(md).toBe('> line one\n> line two');
  });

  it('escapes markdown syntax characters in text', () => {
    const md = spansToMarkdown([block('paragraph'), text('2*3 [not](a link)')]);
    expect(md).toBe('2\\*3 \\[not\\](a link)');
  });

  it('treats text before the first marker as a paragraph', () => {
    expect(spansToMarkdown([text('leading')])).toBe('leading');
    expect(spansToMarkdown([])).toBe('');
  });
});

describe('markdownToSpans', () => {
  it('parses the block vocabulary', () => {
    expect(markdownToSpans('## Sub\n\ntext\n\n---\n\n> quoted')).toEqual([
      block('heading', [], { level: 2 }), text('Sub'),
      block('paragraph'), text('text'),
      block('divider'),
      block('blockquote'), text('quoted'),
    ]);
  });

  it('parses nested lists', () => {
    expect(markdownToSpans('- a\n  - b\n1. c')).toEqual([
      block('unordered-list-item'), text('a'),
      block('unordered-list-item', ['unordered-list-item']), text('b'),
      block('ordered-list-item'), text('c'),
    ]);
  });

  it('parses inline formatting and links', () => {
    expect(markdownToSpans('a **b** *c* [d](http://e)')).toEqual([
      block('paragraph'),
      text('a '),
      text('b', { strong: true }),
      text(' '),
      text('c', { em: true }),
      text(' '),
      text('d', { link: JSON.stringify({ href: 'http://e' }) }),
    ]);
  });

  it('joins soft-wrapped paragraph lines', () => {
    expect(markdownToSpans('one\ntwo')).toEqual([
      block('paragraph'), text('one'), text(' '), text('two'),
    ]);
  });

  it('honors escapes', () => {
    expect(markdownToSpans('2\\*3\\*4')).toEqual([block('paragraph'), text('2*3*4')]);
  });
});

describe('round trip', () => {
  const cases: Record<string, string> = {
    document: '# Title\n\nSome **bold** and *italic* text with a [link](https://x.dev).\n\n## Section\n\n> a quote\n> second line\n\n- item one\n  - nested\n1. numbered\n2. also\n\n---\n\nThe end.',
    escapes: 'Math: 2\\*3 and \\[brackets\\]',
    nestedMarks: 'A ***bold italic*** run.',
  };
  for (const [name, md] of Object.entries(cases)) {
    it(`markdown → spans → markdown is stable (${name})`, () => {
      expect(spansToMarkdown(markdownToSpans(md))).toBe(md);
    });
  }
});
