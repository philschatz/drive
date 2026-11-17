/**
 * Reading documents straight from storage — no keyhive, no Repo.
 *
 * When a device lands on a build whose keyhive cannot read the old state, the
 * engine refuses to boot, but the documents' own storage chunks are ordinary
 * Automerge data. This is what lets the reset screen still offer a backup.
 * The reference for "correct" is the snapshot the OLD build itself exported for
 * the same captured profile (tests/fixtures/legacy-alpha58.json).
 */
import * as Automerge from '@automerge/automerge';
import { loadDocFromStorage, buildLegacyBackup } from '../src/shared/legacy-backup';
import { parseBackup, serializeBackup } from '../src/shared/backup';
import { KEYS } from '../src/shared/storage-keys';
import { makeMemStorage } from './support/mem-storage';
import { seedLegacyProfile } from './support/legacy-fixture';

const plain = (d: any) => JSON.parse(JSON.stringify(d));

describe('loadDocFromStorage', () => {
  it('rebuilds each fixture document exactly as the old build exported it', async () => {
    const { fx, storage } = seedLegacyProfile(makeMemStorage({ strictEmptyPrefix: true }));
    const byName = new Map(fx.snapshot.docs.map((d) => [d.metadata?.name, d]));
    const names: Record<string, string> = { calendar: 'Trip', tasks: 'Chores', sentences: 'Notes' };

    for (const [kind, docId] of Object.entries(fx.docs)) {
      const doc = await loadDocFromStorage(storage, Automerge, docId);
      expect(doc).not.toBeNull();
      const reference = Automerge.load<any>(byName.get(names[kind])!.bin);
      expect(plain(doc)).toEqual(plain(reference));
      expect(Automerge.getHeads(doc!).sort()).toEqual(Automerge.getHeads(reference).sort());
    }
  });

  it('keeps rich-text structure the JSON projection cannot carry', async () => {
    const { fx, storage } = seedLegacyProfile();
    const doc = await loadDocFromStorage(storage, Automerge, fx.docs.sentences);
    const spans = Automerge.spans(doc!, ['content']) as any[];
    expect(spans.some((s) => s.type === 'block' && s.value.type === 'heading')).toBe(true);
    expect(spans.some((s) => s.type === 'text' && s.marks?.strong)).toBe(true);
  });

  it('applies incremental chunks on top of the snapshot', async () => {
    const storage = makeMemStorage();
    let doc = Automerge.from<any>({ '@type': 'TaskList', name: 'A', tasks: {} });
    await storage.save(['docX', 'snapshot', 'h1'], Automerge.save(doc));
    const before = Automerge.clone(doc);
    doc = Automerge.change(doc, (d) => { d.name = 'B'; });
    await storage.save(['docX', 'incremental', 'h2'], Automerge.saveSince(doc, Automerge.getHeads(before)));

    expect(plain(await loadDocFromStorage(storage, Automerge, 'docX')).name).toBe('B');
  });

  it('returns null for a document with no chunks', async () => {
    expect(await loadDocFromStorage(makeMemStorage(), Automerge, 'missing')).toBeNull();
  });
});

describe('buildLegacyBackup', () => {
  it('produces the same snapshot the old build exported: every document and the settings', async () => {
    const { fx, storage, kv } = seedLegacyProfile();
    const { payload, unreadable } = await buildLegacyBackup({
      storage, Automerge,
      docs: (await kv.get<any[]>(KEYS.docIds))!,
      settings: await kv.get(KEYS.driveSettings),
    });

    expect(unreadable).toEqual([]);
    expect(payload.kind).toBe('snapshot');
    expect(payload.docs!.map((d) => d.metadata?.name).sort()).toEqual(['Chores', 'Notes', 'Trip']);
    const ref = new Map(fx.snapshot.docs.map((d) => [d.metadata?.name, d]));
    for (const item of payload.docs!) {
      const r = ref.get(item.metadata?.name)!;
      expect(item.metadata).toEqual(r.metadata);
      expect(item.doc).toEqual(r.doc);            // undefined for Sentences on both sides
      expect(item.markdown).toEqual(r.markdown);  // the readable rendering, Sentences only
      expect(plain(Automerge.load(item.bin!))).toEqual(plain(Automerge.load(r.bin)));
    }
    expect(payload.settings).toEqual(fx.snapshot.settings);
  });

  it('is NOT tagged with a keyhive generation, so an import treats its friends as stale', async () => {
    const { storage, kv } = seedLegacyProfile();
    const { payload } = await buildLegacyBackup({
      storage, Automerge, docs: (await kv.get<any[]>(KEYS.docIds))!, settings: await kv.get(KEYS.driveSettings),
    });
    expect(payload.keyhive).toBeUndefined();
  });

  it('survives the on-disk JSON round trip the download uses', async () => {
    const { storage, kv } = seedLegacyProfile();
    const { payload } = await buildLegacyBackup({
      storage, Automerge, docs: (await kv.get<any[]>(KEYS.docIds))!, settings: await kv.get(KEYS.driveSettings),
    });
    const parsed = parseBackup(serializeBackup(payload));
    expect(parsed.kind).toBe('snapshot');
    expect((parsed as any).payload.docs).toHaveLength(3);
    expect((parsed as any).payload.docs[0].bin).toBeInstanceOf(Uint8Array);
  });

  it('reports a document it cannot read and still exports the rest', async () => {
    const { storage, kv } = seedLegacyProfile();
    const docs = (await kv.get<any[]>(KEYS.docIds))!;
    docs.push({ id: 'goneDocId', type: 'Calendar', name: 'Lost' });
    await storage.save(['corruptDocId', 'snapshot', 'h'], Uint8Array.from([1, 2, 3, 4]));
    docs.push({ id: 'corruptDocId', type: 'Calendar', name: 'Garbled' });

    const { payload, unreadable } = await buildLegacyBackup({ storage, Automerge, docs, settings: null });
    expect(payload.docs).toHaveLength(3);
    expect(unreadable.sort()).toEqual(['Garbled', 'Lost']);
    expect(payload.settings).toBeUndefined();
  });

  it('reads settings from a synced settings document when the kv value is its id', async () => {
    const storage = makeMemStorage();
    const settingsDoc = Automerge.from<any>({
      '@type': 'DriveSettings',
      friends: { ['A'.repeat(43) + '=']: 'Ann' },
      deviceNames: { ['B'.repeat(43) + '=']: 'Phone' },
      archivedDocIds: {},
    });
    await storage.save(['settingsDocId', 'snapshot', 'h'], Automerge.save(settingsDoc));

    const { payload } = await buildLegacyBackup({ storage, Automerge, docs: [], settings: 'settingsDocId' });
    expect(payload.settings).toEqual({
      friends: { ['A'.repeat(43) + '=']: 'Ann' },
      deviceNames: { ['B'.repeat(43) + '=']: 'Phone' },
      archivedDocIds: {},
    });
  });
});
