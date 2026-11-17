/**
 * `changeDoc`: the in-process write path the CLI's Timeline feeder uses. It
 * shares `applyDocChange` with the UI's `update-doc`, so a change is one
 * Automerge change, subscribers are pushed, DriveSettings stays enforced —
 * and it hands the caller an ImmutableString helper for thumbnails.
 */
import * as A from '@automerge/automerge';
import { DriveEngine } from '../src/shared/drive-engine';
import { createTimelineDoc } from '../src/shared/schemas/timeline';
import { addPrompts } from '../src/shared/timeline/changes';
import { DRIVE_SETTINGS_TYPE, createDriveSettingsDocJson } from '../src/shared/schemas';

const { Repo, decodeHeads } = require('@automerge/automerge-repo');

const repo = new Repo({ network: [] });
afterAll(async () => { await repo.shutdown(); });

function makeEngine() {
  const emitted: any[] = [];
  const engine = new DriveEngine({
    emit: (e: any) => emitted.push(e),
    kv: { get: async () => null, set: async () => {}, del: async () => {}, delPrefix: async () => {} },
  } as any);
  (engine as any).lastViewedHeads = {};
  (engine as any).Automerge = A;
  (engine as any).decodeHeads = decodeHeads;
  (engine as any).repo = repo;
  return { engine, emitted };
}

describe('changeDoc', () => {
  it('makes one change, never touched by the engine registry first, with ImmutableString thumbnails', async () => {
    const { engine } = makeEngine();
    const handle = repo.create(createTimelineDoc('Life'));
    const docId = handle.documentId as string;
    const before = A.getAllChanges(handle.doc()).length;

    await engine.changeDoc(docId, (d, h) => addPrompts(d, {
      prompts: { 'photo-1': { source: 'photos', added: '2026-11-17T00:00:00.000Z', cover: 'p1', count: 2 } },
      thumbs: { p1: 'QUJD' },
    }, h.immutableString));

    const doc = handle.doc();
    expect(A.getAllChanges(doc).length).toBe(before + 1);
    expect(doc.prompts['photo-1'].cover).toBe('p1');
    expect(A.isImmutableString(doc.thumbs.p1)).toBe(true);
    expect(String(doc.thumbs.p1)).toBe('QUJD');
  });

  it('pushes to subscribers like a UI change', async () => {
    const { engine, emitted } = makeEngine();
    (engine as any).jqCache.set('.prompts', (d: any) => JSON.parse(JSON.stringify(d.prompts ?? {})));
    const handle = repo.create(createTimelineDoc('Life'));
    const docId = handle.documentId as string;
    (engine as any).getOrCreateEntry(docId, handle);
    await engine.handleMessage({ type: 'subscribe-query', subId: 7, docId, filter: '.prompts' } as any);
    emitted.length = 0;
    await engine.changeDoc(docId, d => { d.prompts.k = { source: 'gap', added: 'x' }; });
    const push = emitted.filter(e => e.type === 'query-result' && e.subId === 7).at(-1);
    expect(push?.result).toEqual({ k: { source: 'gap', added: 'x' } });
  });

  it('DriveSettings stays enforced: an invalid change is refused, not stored', async () => {
    const { engine } = makeEngine();
    const handle = repo.create(createDriveSettingsDocJson());
    const docId = handle.documentId as string;
    expect(handle.doc()['@type']).toBe(DRIVE_SETTINGS_TYPE);
    await expect(engine.changeDoc(docId, d => { d.friends = 'not a map'; })).rejects.toThrow();
    expect(typeof handle.doc().friends).not.toBe('string');
  });
});
