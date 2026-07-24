/**
 * DriveSettings-backed contact/device stores + enforced validation.
 *
 * The engine reads/writes the contact roster, device names, and archived-doc
 * tombstones through a loaded DriveSettings handle (the synced source of truth),
 * keeping the same *-updated broadcasts. Writes go through changeDriveSettings,
 * which validates on a clone and throws rather than commit an invalid document.
 *
 * These tests seed a fake settings handle + minimal Automerge stub directly
 * (bypassing keyhive) to exercise that logic in isolation.
 */
import { DriveEngine } from '../src/shared/drive-engine';

const ID = 'A'.repeat(43) + '=';   // valid keyhive id (base64 of 32 bytes)
const ID2 = 'B'.repeat(43) + '=';
const DOC = '1'.repeat(48);        // valid automerge docId shape

/** Minimal Automerge stub: clone + change over plain objects. */
const Automerge = {
  clone: (d: any) => structuredClone(d),
  change: (d: any, fn: (x: any) => void) => { const c = structuredClone(d); fn(c); return c; },
};

function makeEngine() {
  const kv = new Map<string, any>();
  const emitted: any[] = [];
  const engine = new DriveEngine({
    emit: (e: any) => emitted.push(e),
    kv: {
      get: async (k: string) => kv.get(k) ?? null,
      set: async (k: string, v: any) => { kv.set(k, structuredClone(v)); },
      del: async (k: string) => { kv.delete(k); },
      delPrefix: async () => {},
    },
  } as any);

  // Seed a loaded DriveSettings handle so ensureDriveSettingsDoc() returns it
  // immediately (no keyhive needed).
  let state: any = { '@type': 'DriveSettings', contacts: {}, deviceNames: {}, lastViewedHeads: {}, archivedDocIds: {} };
  const handle = {
    doc: () => state,
    change: (fn: (d: any) => void) => { const c = structuredClone(state); fn(c); state = c; },
    on: () => {},
  };
  (engine as any).Automerge = Automerge;
  (engine as any).lastViewedHeads = {};
  (engine as any).driveSettingsHandle = handle;
  (engine as any).driveSettingsDocId = DOC;

  const e = engine as any;
  const contactEvents = () => emitted.filter(x => x.type === 'contact-names-updated');
  const deviceEvents = () => emitted.filter(x => x.type === 'device-names-updated');
  return { engine: e, docState: () => state, emitted, contactEvents, deviceEvents };
}

describe('contact roster (unified contacts map)', () => {
  it('putContactName writes a name and broadcasts', async () => {
    const { engine, docState, contactEvents } = makeEngine();
    await engine.putContactName(ID, 'Alice');
    expect(docState().contacts[ID]).toBe('Alice');
    expect(await engine.getContactNames()).toEqual({ [ID]: 'Alice' });
    expect(contactEvents().at(-1).names).toEqual({ [ID]: 'Alice' });
  });

  it('addKnownContactGroup records an unnamed (null) contact, excluded from names', async () => {
    const { engine, docState } = makeEngine();
    const already = await engine.addKnownContactGroup(ID2);
    expect(already).toBe(false);
    expect(docState().contacts[ID2]).toBeNull();
    // Named-only view drops the null; the roster (keys) still includes it.
    expect(await engine.getContactNames()).toEqual({});
    expect(Object.keys(docState().contacts)).toContain(ID2);
    // Idempotent: a second add reports already-known.
    expect(await engine.addKnownContactGroup(ID2)).toBe(true);
  });

  it('deleteContactName removes the contact from the roster entirely', async () => {
    const { engine, docState } = makeEngine();
    await engine.putContactName(ID, 'Alice');
    await engine.deleteContactName(ID);
    expect(ID in docState().contacts).toBe(false);
  });

  it('putDeviceName writes + broadcasts device names', async () => {
    const { engine, docState, deviceEvents } = makeEngine();
    await engine.putDeviceName(ID, '💻 Firefox');
    expect(docState().deviceNames[ID]).toBe('💻 Firefox');
    expect(deviceEvents().at(-1).names).toEqual({ [ID]: '💻 Firefox' });
  });
});

describe('archived-doc tombstones (in the doc)', () => {
  it('set + read a tombstone through the doc', () => {
    const { engine, docState } = makeEngine();
    engine.setArchivedTombstone(DOC, { grantSigs: ['sig1'] });
    expect(docState().archivedDocIds[DOC]).toEqual({ grantSigs: ['sig1'] });
    expect(engine.getArchivedTombstones()).toEqual({ [DOC]: { grantSigs: ['sig1'] } });
  });
});

describe('enforced validation (changeDriveSettings)', () => {
  it('rejects an invalid contact value (number) — nothing committed', () => {
    const { engine, docState } = makeEngine();
    expect(() => engine.changeDriveSettings((d: any) => { d.contacts[ID] = 5; })).toThrow(/rejected/i);
    expect(docState().contacts[ID]).toBeUndefined();
  });

  it('rejects a malformed contact key', () => {
    const { engine } = makeEngine();
    expect(() => engine.changeDriveSettings((d: any) => { d.contacts['not-an-id'] = 'x'; })).toThrow(/rejected/i);
  });

  it('rejects a stray top-level key', () => {
    const { engine } = makeEngine();
    expect(() => engine.changeDriveSettings((d: any) => { d.bogus = 1; })).toThrow(/rejected/i);
  });

  it('putContactName with a malformed id rejects', async () => {
    const { engine } = makeEngine();
    await expect(engine.putContactName('bad-id', 'x')).rejects.toThrow(/rejected/i);
  });
});
