/**
 * The parts of the schema DSL that exist for rich text: the `json()` node, and
 * the two functions that let a caller find and check markers the JSON
 * projection cannot show it.
 */
import {
  arr, bool, json, num, obj, record, richTextPathsFor, schemaAt, str, union,
  validateNode, type SchemaNode, type ValidationError,
} from './core';

const errsFor = (value: unknown, schema: SchemaNode): string[] => {
  const errors: ValidationError[] = [];
  validateNode(value, schema, [], errors);
  return errors.map(e => e.message);
};

describe('json()', () => {
  const schema = json(obj({ href: str() }));

  it('accepts a JSON string matching the inner schema', () => {
    expect(errsFor(JSON.stringify({ href: 'https://example.com' }), schema)).toEqual([]);
  });

  it('rejects a non-string', () => {
    expect(errsFor(42, schema)).toEqual([expect.stringMatching(/Expected a JSON string, got number/)]);
  });

  it('rejects a string that is not JSON', () => {
    expect(errsFor('https://example.com', schema)).toEqual([expect.stringMatching(/Expected a JSON string/)]);
  });

  it('applies the inner schema to the parsed value', () => {
    expect(errsFor(JSON.stringify({ href: 42 }), schema)).toEqual([
      expect.stringMatching(/Expected string, got number/),
    ]);
  });
});

describe('schemaAt', () => {
  const schema = obj({
    name: str(),
    notes: record(obj({ body: str({ richText: { marks: { strong: bool({ literal: true }) } } }) })),
    tags: arr(str()),
    either: union([obj({ a: num() }), obj({ b: str() })]),
  });

  it('resolves through object properties', () => {
    expect(schemaAt(schema, ['name'])).toEqual(str());
  });

  it('resolves through a record to its value schema', () => {
    const node = schemaAt(schema, ['notes', 'anyKey', 'body']);
    expect(node?.type).toBe('string');
    expect((node as any).richText.marks.strong).toBeDefined();
  });

  it('resolves through an array by index', () => {
    expect(schemaAt(schema, ['tags', 0])).toEqual(str());
    expect(schemaAt(schema, ['tags', 'notAnIndex'])).toBeUndefined();
  });

  it('resolves through the first union branch that covers the segment', () => {
    expect(schemaAt(schema, ['either', 'a'])).toEqual(num());
    expect(schemaAt(schema, ['either', 'b'])).toEqual(str());
  });

  it('returns undefined for a path the schema does not cover', () => {
    expect(schemaAt(schema, ['nope'])).toBeUndefined();
    expect(schemaAt(schema, ['name', 'deeper'])).toBeUndefined();
  });
});

describe('richTextPathsFor', () => {
  const rich = str({ richText: { marks: { strong: bool({ literal: true }) } } });

  it('finds a declared field at the top level', () => {
    expect(richTextPathsFor(obj({ content: rich, name: str() }), { content: 'x', name: 'y' }))
      .toEqual([['content']]);
  });

  it('expands record keys against the document', () => {
    const schema = obj({ notes: record(obj({ body: rich })) });
    expect(richTextPathsFor(schema, { notes: { a: { body: '' }, b: { body: '' } } }))
      .toEqual([['notes', 'a', 'body'], ['notes', 'b', 'body']]);
  });

  it('expands array indices against the document', () => {
    const schema = obj({ paras: arr(rich) });
    expect(richTextPathsFor(schema, { paras: ['one', 'two'] })).toEqual([['paras', 0], ['paras', 1]]);
  });

  it('skips branches the document does not have', () => {
    const schema = obj({ notes: record(obj({ body: rich })) });
    expect(richTextPathsFor(schema, {})).toEqual([]);
    expect(richTextPathsFor(schema, { notes: {} })).toEqual([]);
  });

  it('returns nothing when no field declares richText', () => {
    expect(richTextPathsFor(obj({ name: str(), n: num() }), { name: 'x', n: 1 })).toEqual([]);
  });
});
