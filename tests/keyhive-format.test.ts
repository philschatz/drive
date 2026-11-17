/**
 * Detecting and resetting keyhive state written by the pre-upgrade build.
 *
 * keyhive >= 0.6 cannot read anything alpha.58 wrote (archives, stored events,
 * prekey-secret exports), and the bridge's boot path on such state either
 * throws or silently replaces it with a fresh keyhive. So the state must be
 * recognised BEFORE the bridge runs, and removed deliberately.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeFSStorageAdapter } from '@automerge/automerge-repo-storage-nodefs';
import {
  inspectKeyhiveStorage, markKeyhiveFormat, ensureKeyhiveStorageUsable, resetKeyhiveState,
  KeyhiveResetRequiredError, KEYHIVE_STORAGE_GENERATION, KEYHIVE_FORMAT_MARKER_KEY,
} from '../src/shared/keyhive-format';
import { KEYS } from '../src/shared/storage-keys';
import { makeMemStorage, makeMemKv } from './support/mem-storage';
import { seedLegacyProfile, loadLegacyFixture } from './support/legacy-fixture';

/** A framed (keyhive >= 0.6) archive starts "KHIV" + a format byte. */
const KHIV = Uint8Array.from([0x4b, 0x48, 0x49, 0x56, 0x04, 0x0a, 0x1d, 0xd3]);
const ARCHIVE = (hash: string) => ['keyhive-db', '/archives/', hash];

describe('inspectKeyhiveStorage', () => {
  it('a brand-new profile is fresh', async () => {
    expect(await inspectKeyhiveStorage(makeMemStorage({ strictEmptyPrefix: true }))).toEqual({ kind: 'fresh' });
  });

  it('the captured alpha.58 profile is legacy', async () => {
    const { storage } = seedLegacyProfile(makeMemStorage({ strictEmptyPrefix: true }));
    expect(await inspectKeyhiveStorage(storage)).toEqual({ kind: 'legacy', reason: 'archive-format' });
  });

  it('a marked profile is current without reading keyhive-db', async () => {
    const storage = makeMemStorage();
    await markKeyhiveFormat(storage);
    // An unreadable archive is deliberately present: the marker is trusted.
    await storage.save(ARCHIVE('aa'), Uint8Array.from([7, 0, 0, 0]));
    const loadRange = jest.spyOn(storage, 'loadRange');
    expect(await inspectKeyhiveStorage(storage)).toEqual({ kind: 'current', marked: true });
    expect(loadRange).not.toHaveBeenCalled();
  });

  it('an unmarked profile whose archives are all framed is current (adopted)', async () => {
    const storage = makeMemStorage();
    await storage.save(ARCHIVE('aa'), KHIV);
    await storage.save(ARCHIVE('bb'), KHIV);
    expect(await inspectKeyhiveStorage(storage)).toEqual({ kind: 'current', marked: false });
  });

  it('one old-format archive among framed ones is still legacy', async () => {
    const storage = makeMemStorage();
    await storage.save(ARCHIVE('aa'), KHIV);
    await storage.save(ARCHIVE('bb'), Uint8Array.from([7, 0, 0, 0, 0, 0, 0, 0]));
    expect(await inspectKeyhiveStorage(storage)).toEqual({ kind: 'legacy', reason: 'archive-format' });
  });

  it('keyhive-db chunks with no archive are legacy (a reset that crashed half-way)', async () => {
    const storage = makeMemStorage();
    await storage.save(['keyhive-db', '/prekey-secrets'], Uint8Array.from([7, 0, 0, 0]));
    expect(await inspectKeyhiveStorage(storage)).toEqual({ kind: 'legacy', reason: 'no-archive' });
    const opsOnly = makeMemStorage();
    await opsOnly.save(['keyhive-db', '/ops/', 'ab'], Uint8Array.from([2, 0, 0, 0]));
    expect(await inspectKeyhiveStorage(opsOnly)).toEqual({ kind: 'legacy', reason: 'no-archive' });
  });

  it('a marker from a later generation is reported, not treated as legacy', async () => {
    const storage = makeMemStorage();
    await storage.save(KEYHIVE_FORMAT_MARKER_KEY, Uint8Array.of(KEYHIVE_STORAGE_GENERATION + 1));
    expect(await inspectKeyhiveStorage(storage)).toEqual({ kind: 'newer', found: KEYHIVE_STORAGE_GENERATION + 1 });
  });

  it('the device key alone (identity, no keyhive state) is fresh', async () => {
    const storage = makeMemStorage();
    await storage.save(['active-key-pair-2'], Uint8Array.from([1, 2, 3]));
    expect(await inspectKeyhiveStorage(storage)).toEqual({ kind: 'fresh' });
  });
});

describe('ensureKeyhiveStorageUsable (the guard in front of the bridge)', () => {
  it('marks a fresh profile, so a crash before the first archive cannot look legacy', async () => {
    const storage = makeMemStorage();
    await ensureKeyhiveStorageUsable(storage);
    expect(await storage.load(KEYHIVE_FORMAT_MARKER_KEY)).toEqual(Uint8Array.of(KEYHIVE_STORAGE_GENERATION));
    // …even if only non-archive keyhive chunks exist by the next boot.
    await storage.save(['keyhive-db', '/prekey-secrets'], KHIV);
    await expect(ensureKeyhiveStorageUsable(storage)).resolves.toBeUndefined();
  });

  it('adopts an unmarked framed profile by marking it', async () => {
    const storage = makeMemStorage();
    await storage.save(ARCHIVE('aa'), KHIV);
    await ensureKeyhiveStorageUsable(storage);
    expect(await inspectKeyhiveStorage(storage)).toEqual({ kind: 'current', marked: true });
  });

  it('refuses the legacy profile and leaves every byte in place', async () => {
    const { storage } = seedLegacyProfile();
    const before = storage.keys();
    const err = await ensureKeyhiveStorageUsable(storage).catch((e) => e);
    expect(err).toBeInstanceOf(KeyhiveResetRequiredError);
    expect((err as KeyhiveResetRequiredError).reason).toBe('archive-format');
    expect(storage.keys()).toEqual(before);
  });

  it('refuses state from a later generation with a plain error', async () => {
    const storage = makeMemStorage();
    await storage.save(KEYHIVE_FORMAT_MARKER_KEY, Uint8Array.of(KEYHIVE_STORAGE_GENERATION + 1));
    const err = await ensureKeyhiveStorageUsable(storage).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(KeyhiveResetRequiredError);
    expect(String(err.message)).toMatch(/newer version/i);
  });
});

describe('resetKeyhiveState', () => {
  it('removes the old keyhive state and keeps the device key and every document chunk', async () => {
    const { fx, storage, kv } = seedLegacyProfile();
    const docChunks = storage.keys().filter((k) => !k.startsWith('keyhive-db'));
    expect(storage.keys().some((k) => k.startsWith('keyhive-db'))).toBe(true);

    await resetKeyhiveState(storage, kv);

    const after = storage.keys();
    expect(after.some((k) => k.startsWith('keyhive-db'))).toBe(false);
    expect(after).toContain('active-key-pair-2');
    for (const k of docChunks) expect(after).toContain(k);
    for (const id of Object.values(fx.docs)) expect(after.some((k) => k.startsWith(`${id}|`))).toBe(true);
    expect(await inspectKeyhiveStorage(storage)).toEqual({ kind: 'current', marked: true });
  });

  it('clears the identity pointers and the home list, and records what they were', async () => {
    const { fx, storage, kv } = seedLegacyProfile();
    await kv.set(KEYS.lastViewedHeads, { x: ['h'] });
    await kv.set('cache:query:abc:1', { result: 1 });

    await resetKeyhiveState(storage, kv);

    expect(await kv.get(KEYS.userGroupId)).toBeNull();
    expect(await kv.get(KEYS.docIds)).toEqual([]);
    expect(await kv.get(KEYS.lastViewedHeads)).toBeNull();
    expect(await kv.get('cache:query:abc:1')).toBeNull();
    const pre = await kv.get<any>(KEYS.preResetState);
    expect(pre.userGroupId).toBe(fx.userGroupId);
    expect(pre.docs.map((d: any) => d.id).sort()).toEqual(Object.values(fx.docs).sort());
    expect(typeof pre.resetAt).toBe('string');
  });

  it('keeps device names in a device-local settings blob but drops friends and tombstones', async () => {
    // Device names are keyed by agentId, which survives (the device key is
    // kept). Friends are keyed by user-group ids that no longer exist.
    const { fx, storage, kv } = seedLegacyProfile();
    const before = await kv.get<any>(KEYS.driveSettings);
    expect(Object.keys(before.friends)).toContain(fx.friendGroupId);

    await resetKeyhiveState(storage, kv);

    const after = await kv.get<any>(KEYS.driveSettings);
    expect(after['@type']).toBe('DriveSettings');
    expect(after.friends).toEqual({});
    expect(after.archivedDocIds).toEqual({});
    expect(after.deviceNames).toEqual(before.deviceNames);
  });

  it('drops a synced-settings pointer: its document has no keyhive document behind it any more', async () => {
    const { storage, kv } = seedLegacyProfile();
    await kv.set(KEYS.driveSettings, '2EeMrWrEZbQjzYvsvYeyMCuabmxC37zVxm1C528k2S35r6Z2EJ');
    await resetKeyhiveState(storage, kv);
    expect(await kv.get(KEYS.driveSettings)).toBeNull();
    expect((await kv.get<any>(KEYS.preResetState)).settings).toBe('2EeMrWrEZbQjzYvsvYeyMCuabmxC37zVxm1C528k2S35r6Z2EJ');
  });

  it('is safe to re-run after a crash at any step, and never loses the first record', async () => {
    // Crash after the kv half: storage still legacy, pointers already cleared.
    const a = seedLegacyProfile();
    await a.kv.set(KEYS.preResetState, { docs: [{ id: 'kept' }], settings: null, userGroupId: 'G', resetAt: 'first' });
    await a.kv.set(KEYS.docIds, []);
    await a.kv.del(KEYS.userGroupId);
    await resetKeyhiveState(a.storage, a.kv);
    expect((await a.kv.get<any>(KEYS.preResetState)).resetAt).toBe('first');
    expect(await inspectKeyhiveStorage(a.storage)).toEqual({ kind: 'current', marked: true });

    // Crash mid-delete: only part of keyhive-db is gone (NodeFS deletes are not atomic).
    const b = seedLegacyProfile();
    for (const c of await b.storage.loadRange(['keyhive-db', '/archives/'])) await b.storage.remove(c.key);
    expect((await inspectKeyhiveStorage(b.storage)).kind).toBe('legacy');
    await resetKeyhiveState(b.storage, b.kv);
    expect(b.storage.keys().some((k) => k.startsWith('keyhive-db'))).toBe(false);
  });

  it('refuses to touch a healthy profile', async () => {
    const storage = makeMemStorage();
    await storage.save(ARCHIVE('aa'), KHIV);
    await markKeyhiveFormat(storage);
    const kv = makeMemKv({ [KEYS.docIds]: [{ id: 'd1' }], [KEYS.userGroupId]: 'G' });
    await expect(resetKeyhiveState(storage, kv)).rejects.toThrow(/not.*old-format/i);
    expect(storage.keys()).toContain('keyhive-db|/archives/|aa');
    expect(await kv.get(KEYS.userGroupId)).toBe('G');
  });

  it('works without a kv store (the CalDAV bridge has none)', async () => {
    const { storage } = seedLegacyProfile();
    await resetKeyhiveState(storage);
    expect(await inspectKeyhiveStorage(storage)).toEqual({ kind: 'current', marked: true });
  });
});

describe('on a real NodeFS adapter (the CLI and CalDAV hosts)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kh-format-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('detects, refuses, resets and then accepts the legacy profile', async () => {
    const storage = new NodeFSStorageAdapter(dir) as any;
    expect(await inspectKeyhiveStorage(storage)).toEqual({ kind: 'fresh' });
    for (const c of loadLegacyFixture().full.storage) await storage.save(c.key, c.data);

    expect(await inspectKeyhiveStorage(storage)).toEqual({ kind: 'legacy', reason: 'archive-format' });
    await expect(ensureKeyhiveStorageUsable(storage)).rejects.toBeInstanceOf(KeyhiveResetRequiredError);

    await resetKeyhiveState(storage);
    expect(await storage.loadRange(['keyhive-db'])).toEqual([]);
    expect(await storage.load(['active-key-pair-2'])).toBeDefined();
    await expect(ensureKeyhiveStorageUsable(storage)).resolves.toBeUndefined();
    // A second adapter over the same directory (a process restart) agrees.
    expect(await inspectKeyhiveStorage(new NodeFSStorageAdapter(dir) as any)).toEqual({ kind: 'current', marked: true });
  });
});
