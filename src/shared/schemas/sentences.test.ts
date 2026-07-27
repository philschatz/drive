import { validateDocument } from '.';

describe('Document schema', () => {
  it('accepts a valid document (block markers are plain chars in JSON)', () => {
    expect(validateDocument({ '@type': 'Sentences', name: 'Notes', content: '￼Hello￼world' })).toEqual([]);
    expect(validateDocument({ '@type': 'Sentences', name: 'Empty', content: '' })).toEqual([]);
  });

  it('rejects missing or mistyped fields', () => {
    expect(validateDocument({ '@type': 'Sentences', content: '' })).not.toEqual([]);
    expect(validateDocument({ '@type': 'Sentences', name: 'X', content: 42 })).not.toEqual([]);
    expect(validateDocument({ '@type': 'Sentences', name: 'X' })).not.toEqual([]);
  });
});
