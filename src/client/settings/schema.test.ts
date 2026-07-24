/**
 * DriveSettings document schema — structural + id-pattern validation.
 *
 * Unlike other doc types (advisory validation), DriveSettings edits are enforced:
 * changeDriveSettings rejects any change whose result fails validateDocument. So
 * these cases double as the accept/reject contract for that gate.
 */
import { validateDocument } from '../../shared/schemas';
import { KEYHIVE_ID_RE, AUTOMERGE_DOC_ID_RE, AUTOMERGE_HEAD_RE } from './schema';

// Sample ids that match each id format.
const ID = 'A'.repeat(43) + '=';        // base64 of 32 bytes (keyhive id)
const ID2 = 'B'.repeat(43) + '=';
const DOC = '1'.repeat(48);             // base58check-ish (no 0/O/I/l)
const HEAD = '0'.repeat(64);            // 64 lowercase hex

describe('DriveSettings id patterns', () => {
  it('accept real-shaped ids and reject malformed ones', () => {
    expect(KEYHIVE_ID_RE.test(ID)).toBe(true);
    expect(KEYHIVE_ID_RE.test('short')).toBe(false);
    expect(KEYHIVE_ID_RE.test('A'.repeat(44))).toBe(false); // no '=' pad
    expect(AUTOMERGE_DOC_ID_RE.test(DOC)).toBe(true);
    expect(AUTOMERGE_DOC_ID_RE.test('0OIl')).toBe(false);   // excluded alphabet + too short
    expect(AUTOMERGE_HEAD_RE.test(HEAD)).toBe(true);
    expect(AUTOMERGE_HEAD_RE.test('XYZ')).toBe(false);
    expect(AUTOMERGE_HEAD_RE.test('0'.repeat(63))).toBe(false);
  });
});

describe('validateDocument(DriveSettings)', () => {
  const ok = (doc: unknown) => validateDocument(doc);

  it('accepts a bare doc (all maps optional)', () => {
    expect(ok({ '@type': 'DriveSettings' })).toEqual([]);
  });

  it('accepts a fully-populated valid doc, names or null', () => {
    expect(ok({
      '@type': 'DriveSettings',
      contacts: { [ID]: 'Alice', [ID2]: null },
      deviceNames: { [ID]: '💻 Firefox' },
      lastViewedHeads: { [DOC]: [HEAD] },
      archivedDocIds: { [DOC]: { grantSigs: [] } },
    })).toEqual([]);
  });

  it('rejects an unknown @type', () => {
    expect(ok({ '@type': 'NotSettings' }).length).toBeGreaterThan(0);
  });

  it('rejects a non-string, non-null contact value', () => {
    expect(ok({ '@type': 'DriveSettings', contacts: { [ID]: 5 } }).length).toBeGreaterThan(0);
  });

  it('rejects a malformed contact / device key', () => {
    expect(ok({ '@type': 'DriveSettings', contacts: { 'not-an-id': 'x' } }).length).toBeGreaterThan(0);
    expect(ok({ '@type': 'DriveSettings', deviceNames: { 'nope': 'x' } }).length).toBeGreaterThan(0);
  });

  it('rejects a malformed docId key and a non-hex head', () => {
    expect(ok({ '@type': 'DriveSettings', lastViewedHeads: { 'bad-doc': [HEAD] } }).length).toBeGreaterThan(0);
    expect(ok({ '@type': 'DriveSettings', lastViewedHeads: { [DOC]: ['nothex'] } }).length).toBeGreaterThan(0);
  });

  it('rejects a stray top-level key', () => {
    expect(ok({ '@type': 'DriveSettings', bogus: 1 }).length).toBeGreaterThan(0);
  });
});
