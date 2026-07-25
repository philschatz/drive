/**
 * LOCAL settings backend + one-way opt-in to SHARED.
 *
 * In LOCAL mode the engine installs a lightweight `__local` handle facade over an
 * in-memory blob and persists it to the single KEYS.driveSettings IDB key (an OBJECT
 * value; a string value would mean SHARED). The same store methods, changeDriveSettings,
 * and enforced validation used in SHARED mode work unchanged — no keyhive, no user-group.
 * These tests exercise that path with a plain-Map kv (no keyhive), plus the legacy-key
 * migration and the local→shared opt-in (success + rollback).
 */
import { DriveEngine } from '../src/shared/drive-engine';

const ID = 'A'.repeat(43) + '=';   // valid keyhive id (base64 of 32 bytes)
const ID2 = 'B'.repeat(43) + '=';
const DOC = '1'.repeat(48);        // valid automerge docId shape
const HEAD = 'a'.repeat(64);       // valid automerge change-hash (64 hex)
const KEY = 'data:auth:drive-settings-doc-id'; // KEYS.driveSettings

// Legacy per-key IDB names the local migration consolidates + deletes.
const LEGACY = {
  contactNames: 'data:contact-names',
  deviceNames: 'data:device-names',
  knownContactGroups: 'data:known-contact-groups',
  archivedDocIds: 'data:archived-doc-ids',
};

/** Minimal Automerge stub (only needed by the shared-handle used in the opt-in test). */
const Automerge = {
  clone: (d: any) => structuredClone(d),
  change: (d: any, fn: (x: any) => void) => { const c = structuredClone(d); fn(c); return c; },
};

function makeEngine(seed?: Record<string, any>) {
  const kv = new Map<string, any>(Object.entries(seed ?? {}));
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
  const e = engine as any;
  e.settingsMode = 'local'; // the default; declared explicitly for the harness
  const contactEvents = () => emitted.filter(x => x.type === 'contact-names-updated');
  const deviceEvents = () => emitted.filter(x => x.type === 'device-names-updated');
  const result = () => emitted.filter(x => x.type === 'result').at(-1);
  return { engine: e, kv, emitted, contactEvents, deviceEvents, result };
}

describe('local settings backend (blob under KEYS.driveSettings)', () => {
  it('ensureLocalSettings installs a __local handle over a seeded blob', async () => {
    const { engine, kv } = makeEngine();
    const handle = await engine.ensureLocalSettings();
    expect(handle.__local).toBe(true);
    expect(engine.driveSettingsDoc()['@type']).toBe('DriveSettings');
    // A bare blob only lands in the key once something is written; the seed stays in memory.
    await engine.putContactName(ID, 'Alice');
    const stored = kv.get(KEY);
    expect(typeof stored).toBe('object');          // OBJECT ⇒ still LOCAL
    expect(stored['@type']).toBe('DriveSettings');
  });

  it('store methods read/write the blob and broadcast, minting no user-group', async () => {
    const { engine, kv, contactEvents, deviceEvents } = makeEngine();
    await engine.putContactName(ID, 'Alice');
    await engine.putDeviceName(ID, '💻 Firefox');
    const already = await engine.addKnownContactGroup(ID2);
    await engine.ensureDriveSettingsDoc();
    engine.setArchivedTombstone(DOC, { grantSigs: ['sig1'] });

    const blob = kv.get(KEY);
    expect(blob.contacts[ID]).toBe('Alice');
    expect(blob.contacts[ID2]).toBeNull();         // known-but-unnamed
    expect(blob.deviceNames[ID]).toBe('💻 Firefox');
    expect(blob.archivedDocIds[DOC]).toEqual({ grantSigs: ['sig1'] });
    expect(already).toBe(false);
    expect(typeof kv.get(KEY)).toBe('object');      // never became a docId string
    expect(contactEvents().at(-1).names).toEqual({ [ID]: 'Alice' });
    expect(deviceEvents().at(-1).names).toEqual({ [ID]: '💻 Firefox' });

    await engine.deleteContactName(ID);
    expect(ID in kv.get(KEY).contacts).toBe(false);
  });

  it('enforced validation still rejects invalid changes in local mode', async () => {
    const { engine } = makeEngine();
    await engine.ensureLocalSettings();
    expect(engine.driveSettingsHandle.__local).toBe(true);
    expect(() => engine.changeDriveSettings((d: any) => { d.contacts[ID] = 5; })).toThrow(/rejected/i);
    expect(() => engine.changeDriveSettings((d: any) => { d.contacts['not-an-id'] = 'x'; })).toThrow(/rejected/i);
    expect(() => engine.changeDriveSettings((d: any) => { d.bogus = 1; })).toThrow(/rejected/i);
  });

  it('seen-state persists to device-local IDB (data:last-viewed-heads), not the settings blob', async () => {
    const { engine, kv } = makeEngine();
    await engine.ensureLocalSettings();
    engine.lastViewedHeads = { [DOC]: [HEAD] };
    engine.persistLastViewed();
    expect(kv.get('data:last-viewed-heads')).toEqual({ [DOC]: [HEAD] });
    // Never written into the settings blob (that would sync it into keyhive).
    await engine.putContactName(ID, 'Alice');
    expect(kv.get(KEY).lastViewedHeads).toBeUndefined();
  });
});

describe('local migration (legacy separate keys → single blob)', () => {
  it('consolidates the four legacy keys and deletes them', async () => {
    const { engine, kv } = makeEngine({
      [LEGACY.contactNames]: { [ID]: 'Alice' },
      [LEGACY.knownContactGroups]: [ID2],
      [LEGACY.deviceNames]: { [ID]: 'Laptop' },
      [LEGACY.archivedDocIds]: { [DOC]: { grantSigs: ['s'] } },
    });
    await engine.ensureLocalSettings();

    const blob = kv.get(KEY);
    expect(blob.contacts).toEqual({ [ID]: 'Alice', [ID2]: null });
    expect(blob.deviceNames).toEqual({ [ID]: 'Laptop' });
    expect(blob.archivedDocIds).toEqual({ [DOC]: { grantSigs: ['s'] } });
    // Legacy keys removed; migration marked done (re-run is a no-op).
    for (const k of Object.values(LEGACY)) expect(kv.has(k)).toBe(false);
    expect(engine.legacyMerged).toBe(true);
  });
});

describe('ensure-device-name (seed the default once, never clobber)', () => {
  it('seeds this device name when absent, then no-ops', async () => {
    const { engine, kv } = makeEngine();
    await engine.handleMessage({ type: 'ensure-device-name', id: 1, agentId: ID, name: '💻 Firefox' });
    expect(kv.get(KEY).deviceNames[ID]).toBe('💻 Firefox');
    // A user rename followed by another startup seed must NOT overwrite it.
    await engine.putDeviceName(ID, 'My Laptop');
    await engine.handleMessage({ type: 'ensure-device-name', id: 2, agentId: ID, name: '💻 Chrome' });
    expect(kv.get(KEY).deviceNames[ID]).toBe('My Laptop');
  });
});

describe('one-way opt-in (local → shared)', () => {
  it('migrates the local blob into a synced doc and switches to shared', async () => {
    const { engine, result } = makeEngine();
    await engine.ensureLocalSettings();
    await engine.putContactName(ID, 'Alice');

    // Stub the keyhive create path: install a fake shared handle + a docId pointer.
    let shared: any = { '@type': 'DriveSettings', contacts: {}, deviceNames: {}, archivedDocIds: {} };
    engine.Automerge = Automerge;
    engine.khOps = {}; // truthy: passes the "keyhive available" check
    engine.ensureDriveSettingsDoc = async () => {
      engine.driveSettingsHandle = {
        doc: () => shared,
        change: (fn: any) => { const c = structuredClone(shared); fn(c); shared = c; },
        on: () => {},
      };
      engine.driveSettingsDocId = DOC;
      return engine.driveSettingsHandle;
    };

    await engine.handleMessage({ type: 'enable-settings-sync', id: 1 });

    expect(result().error).toBeUndefined();
    expect(engine.settingsMode).toBe('shared');
    expect(shared.contacts[ID]).toBe('Alice'); // fillMissingSettings copied the blob in
  });

  it('rolls back to local (no data loss) when the synced doc cannot be created', async () => {
    const { engine, kv, result } = makeEngine();
    await engine.ensureLocalSettings();
    await engine.putContactName(ID, 'Alice');

    engine.khOps = {};
    engine.ensureDriveSettingsDoc = async () => null; // keyhive/doc unavailable

    await engine.handleMessage({ type: 'enable-settings-sync', id: 1 });

    expect(result().error).toMatch(/settings document/i);
    expect(engine.settingsMode).toBe('local');
    expect(typeof kv.get(KEY)).toBe('object');        // blob intact
    expect(kv.get(KEY).contacts[ID]).toBe('Alice');   // data preserved
    expect(engine.driveSettingsHandle.__local).toBe(true);
  });

  it('reuses an existing reachable DriveSettings doc instead of creating a duplicate', async () => {
    const { engine, kv, result } = makeEngine();
    await engine.ensureLocalSettings();
    await engine.putContactName(ID, 'Alice');

    const EXISTING = '2'.repeat(48); // the already-synced settings doc's id
    let shared: any = { '@type': 'DriveSettings', contacts: {}, deviceNames: {}, archivedDocIds: {} };
    engine.Automerge = Automerge;
    engine.khOps = {
      // The doc is reachable but NOT in accessibleKhIds (its group/CGKA ops
      // haven't fully synced) — the exact case the old permission-gated discovery missed.
      enumerateUserDocs: async () => ({ reachableKhIds: ['kh'], accessibleKhIds: [] }),
    };
    engine.amDocIdFromBytes = () => EXISTING;
    // findReachableDriveSettingsDocs reads @type off the loaded handle.
    engine.getOrLoadHandle = async () => ({
      isReady: () => true,
      doc: () => shared,
      change: (fn: any) => { const c = structuredClone(shared); fn(c); shared = c; },
      on: () => {},
    });
    // Emulate loadDriveSettingsHandle adopting the reachable doc.
    engine.loadDriveSettingsHandle = async (docId: string) => {
      engine.driveSettingsDocId = docId;
      engine.driveSettingsHandle = {
        doc: () => shared,
        change: (fn: any) => { const c = structuredClone(shared); fn(c); shared = c; },
        on: () => {},
      };
      return engine.driveSettingsHandle;
    };
    // Must NOT be called on the reuse path.
    let created = false;
    engine.ensureDriveSettingsDoc = async () => { created = true; return null; };

    await engine.handleMessage({ type: 'enable-settings-sync', id: 1 });

    expect(result().error).toBeUndefined();
    expect(created).toBe(false);                 // no duplicate minted
    expect(engine.settingsMode).toBe('shared');
    expect(kv.get(KEY)).toBe(EXISTING);          // pointer adopts the existing doc (a string)
    expect(shared.contacts[ID]).toBe('Alice');   // local blob seeded into the adopted doc
  });

  it('creates a new doc when no reachable DriveSettings doc exists', async () => {
    const { engine, result } = makeEngine();
    await engine.ensureLocalSettings();
    await engine.putContactName(ID, 'Alice');

    let shared: any = { '@type': 'DriveSettings', contacts: {}, deviceNames: {}, archivedDocIds: {} };
    engine.Automerge = Automerge;
    engine.khOps = { enumerateUserDocs: async () => ({ reachableKhIds: [], accessibleKhIds: [] }) };
    engine.amDocIdFromBytes = () => DOC;
    let created = false;
    engine.ensureDriveSettingsDoc = async () => {
      created = true;
      engine.driveSettingsHandle = {
        doc: () => shared,
        change: (fn: any) => { const c = structuredClone(shared); fn(c); shared = c; },
        on: () => {},
      };
      engine.driveSettingsDocId = DOC;
      return engine.driveSettingsHandle;
    };

    await engine.handleMessage({ type: 'enable-settings-sync', id: 1 });

    expect(result().error).toBeUndefined();
    expect(created).toBe(true);                  // fell through to create
    expect(engine.settingsMode).toBe('shared');
    expect(shared.contacts[ID]).toBe('Alice');
  });
});
