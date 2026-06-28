import { test, expect } from '@playwright/test';
import { newPeer } from './support/peer';

/**
 * Repro: with cache disabled, create a doc → reload → it should still be listed.
 * Bug report: the doc disappears after reload when the cache is disabled.
 */
test('cache disabled: created doc survives reload', async ({ browser }) => {
  const peer = await newPeer(browser, 'solo');
  const logs: string[] = [];
  peer.page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));

  try {
    // Enable "disable cache" (this persists the flag + reloads the page).
    await peer.page.evaluate(() => (window as any).__drive.setCacheDisabled(true)).catch(() => {});
    await peer.page.waitForFunction(() => !!(window as any).__drive, undefined, { timeout: 60_000 });
    await peer.page.evaluate(() =>
      Promise.all([(window as any).__drive.workerReady, (window as any).__drive.keyhiveReady])
    );

    // Create a doc (mirror Home: createDoc registers it in the worker's list).
    const docId = await peer.page.evaluate(async () => {
      const api = (window as any).__drive;
      const { docId } = await api.createDoc({ '@type': 'Calendar', name: 'Repro Cal', events: {} }, { type: 'Calendar', name: 'Repro Cal' });
      return docId as string;
    });
    expect(docId).toBeTruthy();

    // Give enableSharing + reconcile time to settle.
    await peer.page.waitForTimeout(4000);

    const beforeReload = await peer.page.evaluate(async () => {
      const api = (window as any).__drive;
      const fetched = await api.fetchDocList();
      const idbList = await new Promise<any>((resolve) => {
        const req = indexedDB.open('app-storage');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('keyval', 'readonly');
          const g = tx.objectStore('keyval').get('automerge-doc-ids');
          g.onsuccess = () => resolve(g.result ?? null);
          g.onerror = () => resolve('ERR');
        };
        req.onerror = () => resolve('OPEN_ERR');
      });
      return { getDocList: await api.getDocList(), fetched, idbList };
    });
    console.log('BEFORE RELOAD:', JSON.stringify(beforeReload));

    // Reload.
    await peer.page.reload();
    await peer.page.waitForFunction(() => !!(window as any).__drive, undefined, { timeout: 60_000 });
    await peer.page.evaluate(() =>
      Promise.all([(window as any).__drive.workerReady, (window as any).__drive.keyhiveReady])
    );
    await peer.page.waitForTimeout(4000);

    const afterReload = await peer.page.evaluate(async () => {
      const api = (window as any).__drive;
      const fetched = await api.fetchDocList();
      const idbList = await new Promise<any>((resolve) => {
        const req = indexedDB.open('app-storage');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('keyval', 'readonly');
          const g = tx.objectStore('keyval').get('automerge-doc-ids');
          g.onsuccess = () => resolve(g.result ?? null);
          g.onerror = () => resolve('ERR');
        };
        req.onerror = () => resolve('OPEN_ERR');
      });
      return { getDocList: await api.getDocList(), fetched, idbList };
    });
    console.log('AFTER RELOAD:', JSON.stringify(afterReload));
    console.log('RECONCILE LOGS:', logs.filter(l => l.includes('reconcile')).join(' | '));

    expect(afterReload.fetched.some((e: any) => e.id === docId)).toBe(true);
  } finally {
    await peer.close();
  }
});
