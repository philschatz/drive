/**
 * The engine on old-format keyhive state: it must not hand the storage to the
 * bridge, must not report ready or a generic failure, and must still serve the
 * two requests the reset screen needs — and nothing else.
 *
 * createKeyhiveRepo is replaced by a stand-in that runs the REAL storage guard
 * and then fails loudly if it is ever allowed past it (the real one would boot
 * the keyhive bridge, which Jest stubs).
 */
jest.mock('../src/shared/keyhive-repo', () => {
  const { ensureKeyhiveStorageUsable } = jest.requireActual('../src/shared/keyhive-format');
  return {
    createKeyhiveRepo: jest.fn(async (opts: any) => {
      await ensureKeyhiveStorageUsable(opts.storage);
      throw new Error('test stand-in: the bridge would have run');
    }),
  };
});

import { DriveEngine } from '../src/shared/drive-engine';
import { createKeyhiveRepo } from '../src/shared/keyhive-repo';
import { inspectKeyhiveStorage } from '../src/shared/keyhive-format';
import { KEYS } from '../src/shared/storage-keys';
import { makeMemStorage, makeMemKv } from './support/mem-storage';
import { seedLegacyProfile } from './support/legacy-fixture';
import { captureConsole } from './support/console';

function boot(profile = seedLegacyProfile()) {
  const emitted: any[] = [];
  const engine = new DriveEngine({
    emit: (e: any) => emitted.push(e),
    storage: profile.storage,
    kv: profile.kv,
    network: { networkAdapter: {}, sendOverlayFrame: () => {} },
  } as any);
  const request = async (msg: any) => {
    const id = Math.floor(Math.random() * 1e9);
    await engine.handleMessage({ ...msg, id });
    return emitted.find((e) => e.type === 'result' && e.id === id);
  };
  return { engine, emitted, request, ...profile };
}

describe('engine boot on old-format keyhive state', () => {
  it('announces reset-required and nothing else', async () => {
    const h = boot();
    await h.engine.handleMessage({ type: 'init' } as any);

    const types = h.emitted.map((e) => e.type);
    expect(h.emitted.find((e) => e.type === 'reset-required')).toEqual({
      type: 'reset-required', reason: 'archive-format', docCount: 3,
    });
    for (const t of ['ready', 'kh-ready', 'kh-error', 'error', 'data-warning']) expect(types).not.toContain(t);
  });

  it('leaves every stored byte untouched', async () => {
    const h = boot();
    const before = new Map([...h.storage.store].map(([k, v]) => [k, Buffer.from(v.data).toString('hex')]));
    const kvBefore = JSON.stringify(await h.kv.entries());
    await h.engine.handleMessage({ type: 'init' } as any);
    await h.request({ type: 'export-legacy-backup' });

    const after = new Map([...h.storage.store].map(([k, v]) => [k, Buffer.from(v.data).toString('hex')]));
    expect(after).toEqual(before);
    expect(JSON.stringify(await h.kv.entries())).toBe(kvBefore);
  });

  it('answers every ordinary request with an error instead of hanging or touching a null repo', async () => {
    const h = boot();
    await h.engine.handleMessage({ type: 'init' } as any);

    for (const msg of [
      { type: 'create-doc', initialJson: { '@type': 'Calendar', name: 'x', events: {} } },
      { type: 'get-doc-list' },
      { type: 'export-backup', tiers: ['docs'] },
      { type: 'import-backup', payload: { format: 'drive-backup', version: 1, kind: 'snapshot', exportedAt: '', docs: [] } },
    ]) {
      const res = await h.request(msg);
      expect(res).toBeDefined();
      expect(res.error).toMatch(/reset/i);
    }
    // Fire-and-forget messages (no id) are dropped without a throw.
    await expect(h.engine.handleMessage({ type: 'set-presence', docId: 'd', state: {} } as any)).resolves.toBeUndefined();
  });

  it('exports the documents and settings without keyhive', async () => {
    const h = boot();
    await h.engine.handleMessage({ type: 'init' } as any);
    const res = await h.request({ type: 'export-legacy-backup' });

    expect(res.error).toBeUndefined();
    expect(res.result.unreadable).toEqual([]);
    expect(res.result.payload.docs.map((d: any) => d.metadata.name).sort()).toEqual(['Chores', 'Notes', 'Trip']);
    expect(Object.values(res.result.payload.settings.friends)).toEqual(expect.arrayContaining(['Alice', 'Bob']));
  });

  it('resets on request: old keyhive state gone, documents and device key kept', async () => {
    const h = boot();
    await h.engine.handleMessage({ type: 'init' } as any);
    const res = await h.request({ type: 'reset-keyhive' });

    expect(res.error).toBeUndefined();
    expect(h.storage.keys().some((k) => k.startsWith('keyhive-db'))).toBe(false);
    expect(h.storage.keys()).toContain('active-key-pair-2');
    for (const id of Object.values(h.fx.docs)) expect(h.storage.keys().some((k) => k.startsWith(`${id}|`))).toBe(true);
    expect(await h.kv.get(KEYS.userGroupId)).toBeNull();
    expect(await h.kv.get(KEYS.docIds)).toEqual([]);
    expect(await inspectKeyhiveStorage(h.storage)).toEqual({ kind: 'current', marked: true });
  });
});

describe('after the reset (a normally-booting engine)', () => {
  /** A device that reset on a previous boot: marked storage, pre-reset record in kv. */
  async function resetDevice() {
    const first = boot();
    await first.engine.handleMessage({ type: 'init' } as any);
    await first.request({ type: 'reset-keyhive' });
    (createKeyhiveRepo as jest.Mock).mockClear();
    return boot({ fx: first.fx, storage: first.storage, kv: first.kv });
  }

  it('lets the bridge run', async () => {
    const h = await resetDevice();
    const errors = captureConsole(['error']);
    await h.engine.handleMessage({ type: 'init' } as any);
    // The guard passed, so the stand-in for the bridge was reached.
    expect(h.emitted.map((e) => e.type)).not.toContain('reset-required');
    expect(h.emitted.find((e) => e.type === 'kh-error')?.message).toMatch(/bridge would have run/);
    expect(errors.messages().join('\n')).toMatch(/bridge would have run/);
    errors.restore();
  });

  it('still exports the pre-upgrade documents, from the record the reset left', async () => {
    const h = await resetDevice();
    const info = await h.request({ type: 'get-pre-reset-info' });
    expect(info.result).toMatchObject({ docCount: 3 });
    expect(typeof info.result.resetAt).toBe('string');

    const res = await h.request({ type: 'export-legacy-backup' });
    expect(res.error).toBeUndefined();
    expect(res.result.payload.docs).toHaveLength(3);
  });

  it('refuses a reset: the state is no longer old-format', async () => {
    const h = await resetDevice();
    const errors = captureConsole(['error']);
    const res = await h.request({ type: 'reset-keyhive' });
    expect(res.error).toMatch(/no reset is needed/i);
    expect(errors.messages().join('\n')).toMatch(/reset-keyhive failed.*no reset is needed/i);
    errors.restore();
    expect(await h.kv.get(KEYS.preResetState)).not.toBeNull();
  });
});

describe('a profile that never needed a reset', () => {
  it('has no pre-reset record and nothing to export', async () => {
    const h = boot({ fx: null as any, storage: makeMemStorage(), kv: makeMemKv() });
    expect((await h.request({ type: 'get-pre-reset-info' })).result).toBeNull();
    const errors = captureConsole(['error']);
    expect((await h.request({ type: 'export-legacy-backup' })).error).toMatch(/nothing to export/i);
    expect(errors.messages().join('\n')).toMatch(/export-legacy-backup failed.*nothing to export/i);
    errors.restore();
  });
});
