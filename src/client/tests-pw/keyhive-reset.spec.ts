import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { waitFor } from './support/peer';

/**
 * A device whose saved keyhive state was written by the previous keyhive
 * generation: reset screen → backup → reset → import → documents back.
 *
 * Needs a real browser: the whole point is real IndexedDB contents surviving a
 * real worker boot and two real reloads. The old-format state cannot be made
 * with the current library, so it is a profile captured from the old build
 * (tests/fixtures/legacy-alpha58.json), written straight into IndexedDB from a
 * same-origin page that does not boot the app — seeding through the app's own
 * import would race the live engine's writes.
 */

interface Fixture {
  agentId: string;
  friendGroupId: string;
  full: {
    storage: { key: string[]; data: { __driveBin: string } }[];
    kv: { key: string; value: unknown }[];
  };
}

const fixture: Fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), 'tests/fixtures/legacy-alpha58.json'), 'utf8'),
);

/** The keys under `keyhive-db` currently in the device's storage. */
const keyhiveKeys = (page: import('@playwright/test').Page) =>
  page.evaluate(() => new Promise<string[]>((res, rej) => {
    const open = indexedDB.open('automerge-secure', 1);
    open.onerror = () => rej(open.error);
    open.onsuccess = () => {
      const req = open.result.transaction('documents').objectStore('documents').getAllKeys();
      req.onerror = () => rej(req.error);
      req.onsuccess = () => {
        open.result.close();
        res((req.result as string[][]).filter((k) => k[0] === 'keyhive-db').map((k) => k.join('|')));
      };
    };
  }));

test('an old-format profile is offered a backup and a reset, and gets its documents back', async ({ browser }) => {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', (err) => console.log(`[reset] pageerror: ${err.message}`));
  try {
    // ── Seed the old profile ────────────────────────────────────────────────
    await page.goto('/version.json');
    await page.evaluate(async ({ storage, kv }) => {
      const put = (db: IDBDatabase, store: string, entries: [IDBValidKey, unknown][]) =>
        new Promise<void>((res, rej) => {
          const tx = db.transaction(store, 'readwrite');
          for (const [key, value] of entries) tx.objectStore(store).put(value, key);
          tx.oncomplete = () => res();
          tx.onerror = () => rej(tx.error);
        });
      const open = (name: string, version: number, store: string) =>
        new Promise<IDBDatabase>((res, rej) => {
          const req = indexedDB.open(name, version);
          req.onupgradeneeded = () => { req.result.createObjectStore(store); };
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
      const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

      // The automerge-repo IndexedDB adapter's layout: { key, binary } keyed by the key array.
      const docs = await open('automerge-secure', 1, 'documents');
      await put(docs, 'documents', storage.map((c) => [c.key, { key: c.key, binary: bytes(c.data.__driveBin) }]));
      docs.close();
      // idb-storage.ts's layout: plain values keyed by string, schema version 2.
      const app = await open('app-storage', 2, 'keyval');
      await put(app, 'keyval', kv.map((p) => [p.key, p.value]));
      app.close();
    }, { storage: fixture.full.storage, kv: fixture.full.kv });

    // ── The app refuses to boot keyhive on it, and says so ───────────────────
    await page.goto('/');
    await expect(page.getByTestId('reset-required')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('reset-download-backup')).toContainText('3 documents and your settings');
    // Nothing was touched: the old archive, ops and prekey secrets are all still there.
    const before = await keyhiveKeys(page);
    expect(before.some((k) => k.startsWith('keyhive-db|/archives/'))).toBe(true);
    expect(before.length).toBe(fixture.full.storage.filter((c) => c.key[0] === 'keyhive-db').length);

    // ── Backup, read straight from storage ──────────────────────────────────
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('reset-download-backup').click(),
    ]);
    const backupPath = await download.path();
    const backup = JSON.parse(readFileSync(backupPath!, 'utf8'));
    expect(backup.kind).toBe('snapshot');
    expect(backup.docs.map((d: any) => d.metadata.name).sort()).toEqual(['Chores', 'Notes', 'Trip']);
    expect(backup.keyhive).toBeUndefined(); // pre-reset ids: not this generation's

    // ── Reset ───────────────────────────────────────────────────────────────
    await page.getByTestId('reset-device').click();
    const sheet = page.getByTestId('confirm-reset-device');
    await expect(sheet).toBeVisible();
    await expect(sheet).not.toContainText("haven't downloaded"); // a backup was just taken
    await page.getByTestId('confirm-accept').click();

    // The app reloads onto a fresh keyhive, on the screen that has the import.
    await page.waitForFunction(() => location.hash === '#/settings/backup', undefined, { timeout: 60_000 });
    await page.waitForFunction(() => !!(window as any).__drive, undefined, { timeout: 60_000 });
    await page.evaluate(() => Promise.all([(window as any).__drive.workerReady, (window as any).__drive.keyhiveReady]));
    await expect(page.getByTestId('reset-required')).toHaveCount(0);

    // Same device: the key survived, so the agentId — and with it the device's name — is unchanged.
    const identity = await page.evaluate(() => (window as any).__drive.getIdentity());
    expect(identity.agentId).toBe(fixture.agentId);
    expect(await page.evaluate(() => (window as any).__drive.fetchDocList())).toEqual([]);
    // The old documents are off the list but still on disk, and exportable.
    await expect(page.getByTestId('backup-export-pre-upgrade')).toContainText('3 documents');

    // ── Import the backup through the real screen ───────────────────────────
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('backup-import').click(),
    ]);
    await chooser.setFiles(backupPath!);
    const confirm = page.getByTestId('confirm-backup-snapshot-import');
    await expect(confirm).toBeVisible();
    await expect(page.getByTestId('backup-import-stale-friends')).toBeVisible();
    await Promise.all([
      page.waitForEvent('load'), // the restore reloads the page
      page.getByTestId('confirm-accept').click(),
    ]);
    await page.waitForFunction(() => !!(window as any).__drive, undefined, { timeout: 60_000 });
    await page.evaluate(() => Promise.all([(window as any).__drive.workerReady, (window as any).__drive.keyhiveReady]));

    const call = <T,>(fn: string, ...args: unknown[]) =>
      page.evaluate(({ fn, args }) => (window as any).__drive[fn](...args), { fn, args }) as Promise<T>;

    // Documents are back, under new ids, by name and type.
    const list = await waitFor(
      () => call<{ id: string; type?: string; name?: string }[]>('fetchDocList'),
      (l) => l.length === 3,
      { label: 'three documents restored' },
    );
    expect(list.map((e) => `${e.type}:${e.name}`).sort()).toEqual(['Calendar:Trip', 'Sentences:Notes', 'TaskList:Chores']);

    // …with rich text intact, which only the lossless binary could carry.
    const notes = list.find((e) => e.type === 'Sentences')!;
    const spans = await page.evaluate((docId: string) => {
      const api = (window as any).__drive;
      return new Promise<any[]>((res, rej) => {
        const off = api.subscribeQuery(docId, '.content',
          (_r: any, _h: string[], _m: number | undefined, s: any[]) => { off(); res(s ?? []); },
          (e: any) => rej(new Error(e)), { spansPath: ['content'] });
      });
    }, notes.id);
    expect(spans.some((s) => s.type === 'block' && s.value.type === 'heading')).toBe(true);
    expect(spans.some((s) => s.type === 'text' && s.marks?.strong)).toBe(true);

    // The device can use the restored documents: it is their admin, through a new user group.
    expect((await call<string | null>('getMyAccess', notes.id))?.toLowerCase()).toBe('admin');

    // Friends were keyed by user-group ids that no longer exist: not restored.
    const friends = await call<Record<string, string>>('getAllFriendNames');
    expect(Object.keys(friends)).not.toContain(fixture.friendGroupId);
    expect(Object.values(friends)).not.toContain('Bob');

    // ── And it stays reset ──────────────────────────────────────────────────
    await page.reload();
    await page.waitForFunction(() => !!(window as any).__drive, undefined, { timeout: 60_000 });
    await page.evaluate(() => Promise.all([(window as any).__drive.workerReady, (window as any).__drive.keyhiveReady]));
    await expect(page.getByTestId('reset-required')).toHaveCount(0);
    expect((await call<unknown[]>('fetchDocList')).length).toBe(3);
  } finally {
    await context.close();
  }
});
