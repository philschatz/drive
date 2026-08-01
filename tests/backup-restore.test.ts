/**
 * Tiered backup: export assembly, snapshot import identity handling, settings
 * seeding/merging, invalid-doc skipping, and full wipe/restore parity.
 *
 * The harness mirrors tests/drive-settings.test.ts: in-memory kv + storage, a
 * fake DriveSettings handle + Automerge stub, and a stubbed
 * createKeyhiveDocHandle (the real one needs keyhive WASM). The stub mints a
 * fresh user-group on first use when the device has none, standing in for
 * keyhive's ensureUserGroup({create:true}) inside createKeyhiveDoc.
 */
import { DriveEngine } from '../src/shared/drive-engine';
import { KEYS, CACHE_PREFIX } from '../src/shared/storage-keys';
import { serializeBackup, parseBackup, type BackupPayload } from '../src/shared/backup';

const ID = 'A'.repeat(43) + '=';   // valid keyhive user-group id
const ID2 = 'B'.repeat(43) + '=';
const DOC = '1'.repeat(48);        // valid automerge docId shape

/** Minimal Automerge stub: clone + change over plain objects. */
const Automerge = {
  clone: (d: any) => structuredClone(d),
  change: (d: any, fn: (x: any) => void) => { const c = structuredClone(d); fn(c); return c; },
};

/** Plain-object handle stub: doc/change/isReady/on, no heads (never "seen"). */
function docHandle(doc: any, docId: string) {
  let state: any = structuredClone(doc);
  return {
    documentId: docId,
    doc: () => structuredClone(state),
    change: (fn: (d: any) => void) => { const c = structuredClone(state); fn(c); state = c; },
    isReady: () => true,
    on: () => {},
  };
}

/** In-memory automerge storage adapter (keys = joined path arrays). */
function makeStorage() {
  const store = new Map<string, Uint8Array>();
  const key = (k: string[]) => k.join('\x00');
  return {
    store,
    async load(k: string[]) { return store.get(key(k)); },
    async save(k: string[], data: Uint8Array) { store.set(key(k), data); },
    async remove(k: string[]) { store.delete(key(k)); },
    async loadRange(prefix: string[]) {
      if (prefix.length === 0) {
        return [...store.entries()].map(([k, v]) => ({ key: k.split('\x00'), data: v }));
      }
      const p = prefix.join('\x00');
      const out: { key: string[]; data: Uint8Array }[] = [];
      for (const [k, v] of store) {
        if (k === p || k.startsWith(p + '\x00')) out.push({ key: k.split('\x00'), data: v });
      }
      return out;
    },
    async removeRange(prefix: string[]) {
      if (prefix.length === 0) { store.clear(); return; }
      const p = prefix.join('\x00');
      for (const k of [...store.keys()]) {
        if (k === p || k.startsWith(p + '\x00')) store.delete(k);
      }
    },
  };
}

type HarnessOpts = { userGroupId?: string | null; sharedSettings?: boolean };

function makeEngine(opts: HarnessOpts = {}) {
  const kv = new Map<string, any>();
  const storage = makeStorage();
  const emitted: any[] = [];
  const docHandles = new Map<string, any>();
  const savedDocs = new Map<string, any>();
  const group: { id: string | null } = { id: opts.userGroupId ?? null };

  // Shared-mode settings: a seeded handle the engine resolves directly.
  let settingsState: any = opts.sharedSettings
    ? { '@type': 'DriveSettings', friends: {}, deviceNames: {}, archivedDocIds: {} }
    : null;

  const engine = new DriveEngine({
    emit: (e: any) => emitted.push(e),
    storage,
    kv: {
      get: async (k: string) => kv.get(k) ?? null,
      set: async (k: string, v: any) => { kv.set(k, structuredClone(v)); },
      del: async (k: string) => { kv.delete(k); },
      delPrefix: async (prefix: string) => { for (const k of [...kv.keys()]) if (k.startsWith(prefix)) kv.delete(k); },
      entries: async () => [...kv.entries()].map(([k, v]) => [k, structuredClone(v)]),
    },
    network: { sendOverlayFrame: () => {} },
  } as any);

  (engine as any).Automerge = Automerge;
  (engine as any).lastViewedHeads = {};
  (engine as any).settingsMode = opts.sharedSettings ? 'shared' : 'local';
  if (opts.sharedSettings) {
    (engine as any).driveSettingsHandle = {
      doc: () => settingsState,
      change: (fn: (d: any) => void) => { const c = structuredClone(settingsState); fn(c); settingsState = c; },
      on: () => {},
    };
    (engine as any).driveSettingsDocId = DOC;
  }
  (engine as any).khOps = { getUserGroupId: async () => group.id, getKnownFriends: async () => [] };
  (engine as any).amDocIdFromBytes = () => DOC;
  (engine as any).setNextDocId = () => {};
  (engine as any).repo = {
    storageSubsystem: { saveDoc: async (docId: string, doc: any) => { savedDocs.set(docId, structuredClone(doc)); } },
  };

  // getOrLoadHandle: export reads the handles seeded for the doc list.
  (engine as any).getOrLoadHandle = async (docId: string) => {
    const h = docHandles.get(docId);
    if (!h) throw new Error(`no handle for ${docId}`);
    return h;
  };

  // Stand-in for createKeyhiveDocHandle: mints a user-group on first use when the
  // device has none, then returns a plain handle.
  let nextImportDoc = 0;
  (engine as any).createKeyhiveDocHandle = async (initialJson: any) => {
    if (!group.id) group.id = 'G'.repeat(43) + '=';
    const docId = `imported-doc-${++nextImportDoc}`;
    const handle = docHandle(initialJson, docId);
    docHandles.set(docId, handle);
    return handle;
  };

  return {
    engine: engine as any,
    kv,
    storage,
    emitted,
    group,
    docHandles,
    savedDocs,
    settingsState: () => settingsState,
  };
}

function snapshot(partial: Partial<BackupPayload>): BackupPayload {
  return { format: 'drive-backup', version: 1, kind: 'snapshot', exportedAt: new Date().toISOString(), ...partial };
}

describe('file format (serialize/parse)', () => {
  it('round-trips through JSON, base64-encoding binary chunks', () => {
    const payload: BackupPayload = {
      format: 'drive-backup', version: 1, kind: 'full', exportedAt: 'x',
      kv: [{ key: 'settings:debug', value: true }],
      storage: [{ key: ['keyhive-db', '/archives/', 'ab'], data: new Uint8Array([1, 2, 250]) }],
    };
    const parsed = parseBackup(serializeBackup(payload));
    expect(parsed.kind).toBe('full');
    if (parsed.kind !== 'full') return;
    expect(parsed.payload.kv).toEqual([{ key: 'settings:debug', value: true }]);
    expect(parsed.payload.storage![0].data).toEqual(new Uint8Array([1, 2, 250]));
  });

  it('rejects a legacy v1/v2 metadata blob', () => {
    const legacy = JSON.stringify({ version: 2, docList: [{ id: DOC }], friendNames: { [ID]: 'Alice' } });
    expect(parseBackup(legacy).kind).toBe('invalid');
  });

  it('rejects non-JSON and unknown formats', () => {
    expect(parseBackup('not json').kind).toBe('invalid');
    expect(parseBackup('{"version":3,"docList":[]}').kind).toBe('invalid');
    expect(parseBackup('{}').kind).toBe('invalid');
  });
});

describe('exportBackup (tiers)', () => {
  it('assembles the snapshot tiers (docs + settings)', async () => {
    const { engine, kv, docHandles, settingsState } = makeEngine({ sharedSettings: true });
    kv.set(KEYS.docIds, [{ id: DOC, type: 'Calendar', name: 'Trip' }]);
    kv.set('cache:query:1', { result: 1 }); // disposable; irrelevant to snapshot export
    docHandles.set(DOC, docHandle({ '@type': 'Calendar', name: 'Trip', events: {} }, DOC));
    settingsState().friends[ID] = 'Alice';

    const payload = await engine.exportBackup(['docs', 'settings']);
    expect(payload.kind).toBe('snapshot');
    expect(payload.docs).toHaveLength(1);
    expect(payload.docs![0].doc).toEqual({ '@type': 'Calendar', name: 'Trip', events: {} });
    expect(payload.docs![0].metadata).toEqual({ type: 'Calendar', name: 'Trip' });
    expect(payload.settings!.friends).toEqual({ [ID]: 'Alice' });
    expect(payload.kv).toBeUndefined();
  });

  it('skips a doc that fails to load instead of aborting the export', async () => {
    const { engine, kv, docHandles } = makeEngine();
    kv.set(KEYS.docIds, [
      { id: DOC, type: 'TaskList', name: 'Broken' },
      { id: DOC + '2', type: 'TaskList', name: 'OK' },
    ]);
    // Only the second doc has a loadable handle.
    docHandles.set(DOC + '2', docHandle({ '@type': 'TaskList', name: 'OK', tasks: {} }, DOC + '2'));

    const payload = await engine.exportBackup(['docs']);
    expect(payload.docs).toHaveLength(1);
    expect(payload.docs![0].metadata!.name).toBe('OK');
  });

  it('full tier carries every kv pair + storage chunk but excludes cache:*', async () => {
    const { engine, kv, storage } = makeEngine();
    kv.set(KEYS.docIds, [{ id: DOC }]);
    kv.set('settings:debug-enable', true);
    kv.set('cache:query:1', { result: 1 });
    storage.store.set('d1', new Uint8Array([1, 2, 3]));
    storage.store.set(['keyhive-db', '/archives/', 'ab'].join('\x00'), new Uint8Array([9]));

    const payload = await engine.exportBackup(['full']);
    expect(payload.kind).toBe('full');
    const kvKeys = payload.kv!.map(e => e.key).sort();
    expect(kvKeys).toEqual([KEYS.docIds, 'settings:debug-enable']);
    expect(payload.storage).toHaveLength(2);
    expect(payload.storage!.find(c => c.key[0] === 'keyhive-db')!.data).toEqual(new Uint8Array([9]));
  });
});

describe('importBackup (snapshot)', () => {
  const taskDocs: BackupPayload['docs'] = [
    { doc: { '@type': 'TaskList', name: 'Chores', tasks: {} }, metadata: { type: 'TaskList', name: 'Chores' } },
  ];

  it('fresh device: mints a user-group that administers the imported docs', async () => {
    const { engine, group, kv, savedDocs } = makeEngine(); // no group yet
    const result = await engine.importBackup(snapshot({ docs: taskDocs }));
    expect(result.imported).toBe(1);
    expect(result.reload).toBe(true);
    expect(group.id).toBe('G'.repeat(43) + '=');
    const list = kv.get(KEYS.docIds);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ type: 'TaskList', name: 'Chores' });
    expect(savedDocs.size).toBe(1); // each recreated doc is saved to storage
  });

  it('device with a group: reuses the existing identity', async () => {
    const { engine, group, kv } = makeEngine({ userGroupId: ID });
    const result = await engine.importBackup(snapshot({ docs: taskDocs }));
    expect(result.imported).toBe(1);
    expect(group.id).toBe(ID); // unchanged
    expect(kv.get(KEYS.docIds)).toHaveLength(1);
  });

  it('skips schema-invalid docs and reports their names', async () => {
    const { engine } = makeEngine({ userGroupId: ID });
    const result = await engine.importBackup(snapshot({
      docs: [
        { doc: { '@type': 'Bogus', name: 'Bad' }, metadata: { name: 'Bad' } },
        { doc: null as any, metadata: { name: 'Null' } },
        { doc: { '@type': 'TaskList', name: 'Good', tasks: {} }, metadata: { name: 'Good' } },
      ],
    }));
    expect(result.imported).toBe(1);
    expect(result.skipped).toEqual(['Bad', 'Null']);
  });
});

describe('settings import', () => {
  it('merges into the synced doc when a user-group exists', async () => {
    const { engine, settingsState } = makeEngine({ userGroupId: ID, sharedSettings: true });
    await engine.importBackup(snapshot({
      settings: { friends: { [ID]: 'Alice' }, deviceNames: { [ID]: 'Laptop' } },
    }));
    expect(settingsState().friends[ID]).toBe('Alice');
    expect(settingsState().deviceNames[ID]).toBe('Laptop');
  });

  it('skips an invalid entry instead of failing the restore', async () => {
    const { engine, settingsState } = makeEngine({ userGroupId: ID, sharedSettings: true });
    await engine.importBackup(snapshot({ settings: { friends: { bad: 'x', [ID]: 'Alice' } } }));
    expect(settingsState().friends[ID]).toBe('Alice');
    expect(settingsState().friends['bad']).toBeUndefined();
  });

  it('device with a group but LOCAL settings: moves them into a fresh synced doc', async () => {
    const { engine, kv, group, docHandles } = makeEngine({ userGroupId: ID }); // settingsMode 'local'
    await engine.importBackup(snapshot({ settings: { friends: { [ID]: 'Alice' } } }));
    // The settings doc is created and the pointer becomes its docId string (SHARED).
    const pointer = kv.get(KEYS.driveSettings);
    expect(typeof pointer).toBe('string');
    expect(docHandles.get(pointer).doc().friends[ID]).toBe('Alice');
    expect(group.id).toBe(ID);
  });

  it('fresh device with no group: seeds the LOCAL blob without minting a group', async () => {
    const { engine, group, kv } = makeEngine();
    await engine.importBackup(snapshot({ settings: { friends: { [ID]: 'Alice' } } }));
    expect(group.id).toBeNull(); // settings alone never mints a group
    const blob = kv.get(KEYS.driveSettings);
    expect(blob?.['@type']).toBe('DriveSettings');
    expect(blob.friends[ID]).toBe('Alice');
  });
});

describe('full restore (wipe & rewrite)', () => {
  it('replaces storage + kv wholesale, clears cache and in-memory state', async () => {
    const source = makeEngine({ sharedSettings: true });
    source.kv.set(KEYS.docIds, [{ id: DOC, type: 'TaskList', name: 'Chores' }]);
    source.kv.set('settings:debug-enable', true);
    source.kv.set('cache:stale', 1);
    source.storage.store.set('a-chunk', new Uint8Array([7, 8]));
    source.storage.store.set(['keyhive-db', '/archives/', 'zz'].join('\x00'), new Uint8Array([1]));

    const payload = await source.engine.exportBackup(['full']);

    // A fresh device that already has its own (to-be-wiped) data:
    const target = makeEngine();
    target.kv.set('data:existing', 'should be wiped');
    target.storage.store.set('old-chunk', new Uint8Array([9]));

    const result = await target.engine.importBackup(payload);
    expect(result).toEqual({ imported: 0, skipped: [], reload: true });

    expect(target.kv.get(KEYS.docIds)).toEqual([{ id: DOC, type: 'TaskList', name: 'Chores' }]);
    expect(target.kv.get('settings:debug-enable')).toBe(true);
    expect(target.kv.has('cache:stale')).toBe(false);
    expect(target.kv.has('data:existing')).toBe(false);
    expect(target.storage.store.get('a-chunk')).toEqual(new Uint8Array([7, 8]));
    expect(target.storage.store.get(['keyhive-db', '/archives/', 'zz'].join('\x00'))).toEqual(new Uint8Array([1]));
    expect(target.storage.store.has('old-chunk')).toBe(false);

    // In-memory engine state is dropped so nothing stale survives the reload.
    expect(target.engine.docRegistry.size).toBe(0);
    expect(target.engine.settingsSurface.settingsMode).toBe('local');
    expect(target.engine.settingsSurface.driveSettingsHandle).toBeNull();
  });
});
