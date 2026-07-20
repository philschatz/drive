import { validateDocument } from '.';

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  it('rejects null document', () => {
    expect(validateDocument(null)).toEqual([{ path: [], message: 'Document is not an object' }]);
  });

  it('rejects non-object document', () => {
    expect(validateDocument('string')).toEqual([{ path: [], message: 'Document is not an object' }]);
  });
});
