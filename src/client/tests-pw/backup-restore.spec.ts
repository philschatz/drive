import { test, expect } from '@playwright/test';
import { newPeer, waitFor } from './support/peer';

/**
 * Backup/restore across two real isolated devices (own IndexedDB + identity).
 *
 *  - Snapshot tier: Alice's docs + settings export; a fresh device (Bob)
 *    imports and gets the docs recreated under ITS OWN new identity, with the
 *    friend name merged in. A Sentences doc exercises the lossless `bin`
 *    field: the Peritext markup survives a snapshot restore (the flat JSON
 *    projection can't carry it), and the export carries a Markdown rendering.
 *  - Full tier: the same device, moved. The export is base64 (the on-disk
 *    format, mirrors src/shared/backup.ts) because the binary storage chunks
 *    can't cross page.evaluate; Bob imports the whole device state, keeps the
 *    SAME automerge doc ids, and the doc decrypts after a real worker reboot
 *    (the page reload the UI does after a restore).
 *
 * The encode/decode helpers re-implement binToJson/binFromJson from
 * src/shared/backup.ts inline in each page.evaluate (page.evaluate can't
 * import the shared module in a prod build, and a helper passed as an arg
 * can't be serialized because it's recursive).
 */
test('snapshot backup restores documents + settings on a fresh device', async ({ browser }) => {
  const alice = await newPeer(browser, 'alice');
  const bob = await newPeer(browser, 'bob');
  try {
    const { docId } = await alice.call(
      'createDoc',
      { '@type': 'Calendar', name: 'Trip', events: {} },
      { type: 'Calendar', name: 'Trip' }
    );
    await waitFor(
      () => alice.call('fetchDocList'),
      (l) => l.some((e) => e.id === docId),
      { label: 'alice lists her doc' }
    );

    // A Sentences doc with real Peritext markup — the lossless-export regression.
    const { docId: sentencesId } = await alice.call(
      'createDoc',
      { '@type': 'Sentences', name: 'Notes', content: '' },
      { type: 'Sentences', name: 'Notes' }
    );
    await alice.page.evaluate(async (sid: string) => {
      const api = (window as any).__drive;
      const ops = [
        { op: 'splitBlock', index: 0, block: { type: 'heading', parents: [], attrs: { level: 1 } } },
        { op: 'splice', index: 1, del: 0, text: 'Notes' },
        { op: 'mark', start: 1, end: 6, name: 'strong', value: true, expand: 'after' },
      ];
      await api.updateDoc(sid, (d: any, richText: any, o: any[]) => richText(d, ['content'], o), api.richText, ops);
    }, sentencesId);

    // Settings: name alice's own group, so the export has a friend entry.
    const aliceGroup = (await alice.call('ensureUserGroup', { create: true })).userGroupId!;
    await alice.call('setFriendName', aliceGroup, 'Alice');

    // Snapshot entries now carry the lossless `bin` (base64 on disk), so the
    // payload is encoded to the on-disk JSON before crossing to the node process.
    const json = await alice.page.evaluate(async () => {
      const api = (window as any).__drive;
      const payload = await api.exportBackup(['docs', 'settings']);
      const binToJson = (v: any): any => {
        if (v instanceof Uint8Array) {
          let binary = '';
          for (let i = 0; i < v.length; i += 0x8000) {
            binary += String.fromCharCode(...v.subarray(i, i + 0x8000));
          }
          return { __driveBin: btoa(binary) };
        }
        if (Array.isArray(v)) return v.map(binToJson);
        if (v && typeof v === 'object') {
          const out: Record<string, any> = {};
          for (const [k, val] of Object.entries(v)) out[k] = binToJson(val);
          return out;
        }
        return v;
      };
      return JSON.stringify(binToJson(payload));
    });

    // Bob is a fresh device: the docs are recreated under NEW ids (imported
    // docs never reuse the exporting device's doc ids), so match on name/type.
    const result = await bob.page.evaluate(async (json) => {
      const binFromJson = (v: any): any => {
        if (Array.isArray(v)) return v.map(binFromJson);
        if (v && typeof v === 'object') {
          if (typeof v.__driveBin === 'string') {
            const b = atob(v.__driveBin);
            const bytes = new Uint8Array(b.length);
            for (let i = 0; i < b.length; i++) bytes[i] = b.charCodeAt(i);
            return bytes;
          }
          const out: Record<string, any> = {};
          for (const [k, val] of Object.entries(v)) out[k] = binFromJson(val);
          return out;
        }
        return v;
      };
      return await (window as any).__drive.importBackup(binFromJson(JSON.parse(json)));
    }, json);
    expect(result.imported).toBe(2);
    expect(result.reload).toBe(true);

    await waitFor(
      () => bob.call('fetchDocList'),
      (l) => l.some((e) => e.type === 'Calendar' && e.name === 'Trip'),
      { label: 'bob lists the recreated doc' }
    );

    // The Sentences doc came back WITH its markup: the flat projection couldn't
    // carry it, so this only works because the export stored the lossless bin.
    await waitFor(
      () => bob.call('fetchDocList'),
      (l) => l.some((e) => e.type === 'Sentences' && e.name === 'Notes'),
      { label: 'bob lists the recreated sentences doc' }
    );
    const sentencesDoc = (await bob.call('fetchDocList')).find((e) => e.type === 'Sentences')!;
    const spans = await bob.page.evaluate(async (docId: string) => {
      const api = (window as any).__drive;
      return new Promise<any>((resolve, reject) => {
        const unsubscribe = api.subscribeQuery(
          docId, '.content',
          (_result: any, _heads: string[], _lastModified: number | undefined, s: any[]) => {
            unsubscribe();
            resolve(s ?? []);
          },
          (e: any) => reject(new Error(e)),
          { spansPath: ['content'] },
        );
      });
    }, sentencesDoc.id);
    expect(spans.some((s: any) => s.type === 'block' && s.value.type === 'heading')).toBe(true);
    expect(spans.some((s: any) => s.type === 'text' && s.marks?.strong)).toBe(true);

    // Settings landed too: the exported friend name is known on bob.
    await waitFor(
      () => bob.call('getAllFriendNames'),
      (names) => (names as Record<string, string>)[aliceGroup] === 'Alice',
      { label: 'bob knows the friend name' }
    );
  } finally {
    await alice.close();
    await bob.close();
  }
});

test('full backup restores the whole device; the doc decrypts after a reboot', async ({ browser }) => {
  const alice = await newPeer(browser, 'alice');
  const bob = await newPeer(browser, 'bob');
  try {
    const { docId } = await alice.call(
      'createDoc',
      { '@type': 'TaskList', name: 'Chores', tasks: {} },
      { type: 'TaskList', name: 'Chores' }
    );
    await waitFor(
      () => alice.call('fetchDocList'),
      (l) => l.some((e) => e.id === docId),
      { label: 'alice lists her doc' }
    );

    // Export the FULL backup as the on-disk JSON (binary chunks base64'd).
    const json = await alice.page.evaluate(async () => {
      const api = (window as any).__drive;
      const payload = await api.exportBackup(['full']);
      const binToJson = (v: any): any => {
        if (v instanceof Uint8Array) {
          let binary = '';
          for (let i = 0; i < v.length; i += 0x8000) {
            binary += String.fromCharCode(...v.subarray(i, i + 0x8000));
          }
          return { __driveBin: btoa(binary) };
        }
        if (Array.isArray(v)) return v.map(binToJson);
        if (v && typeof v === 'object') {
          const out: Record<string, any> = {};
          for (const [k, val] of Object.entries(v)) out[k] = binToJson(val);
          return out;
        }
        return v;
      };
      return JSON.stringify(binToJson(payload));
    });

    // Bob restores the whole device: same automerge doc ids, same identity.
    const result = await bob.page.evaluate(async (json) => {
      const binFromJson = (v: any): any => {
        if (Array.isArray(v)) return v.map(binFromJson);
        if (v && typeof v === 'object') {
          if (typeof v.__driveBin === 'string') {
            const b = atob(v.__driveBin);
            const bytes = new Uint8Array(b.length);
            for (let i = 0; i < b.length; i++) bytes[i] = b.charCodeAt(i);
            return bytes;
          }
          const out: Record<string, any> = {};
          for (const [k, val] of Object.entries(v)) out[k] = binFromJson(val);
          return out;
        }
        return v;
      };
      return await (window as any).__drive.importBackup(binFromJson(JSON.parse(json)));
    }, json);
    expect(result.reload).toBe(true);

    // The SAME doc id is back (unlike the snapshot tier, nothing is recreated).
    await waitFor(
      () => bob.call('fetchDocList'),
      (l) => l.some((e) => e.id === docId),
      { label: 'bob lists the restored doc id' }
    );

    // The UI reloads after a restore; the rebooted worker must boot from the
    // restored keyhive data and still decrypt the doc.
    await bob.page.reload();
    await bob.page.waitForFunction(() => !!(window as any).__drive, undefined, { timeout: 60_000 });
    await bob.page.evaluate(() =>
      Promise.all([(window as any).__drive.workerReady, (window as any).__drive.keyhiveReady])
    );
    await waitFor(
      () => bob.call('fetchDocList'),
      (l) => l.some((e) => e.id === docId),
      { label: 'doc listed after reboot' }
    );
    await waitFor(
      () => bob.call('queryDoc', docId, '.name'),
      (r) => r.result === 'Chores',
      { label: 'doc decrypts after reboot' }
    );
  } finally {
    await alice.close();
    await bob.close();
  }
});
