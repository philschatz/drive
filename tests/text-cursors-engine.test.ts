/**
 * `text-cursors` through the engine: a mint that names the version its indices
 * belong to.
 *
 * The page asks for cursors by index, and an index only means something
 * against one version of the text. The page's version is the last push it
 * drew; the engine's document can be several peer edits past that (pushes are
 * messages, and a peer's edits can arrive in a burst). Minted against the
 * newer document, "index 21" is some other character — the selection then
 * follows that character instead of the one the user picked.
 *
 * The handle here is a real automerge-repo `DocHandle`, and the heads sent
 * back are the ones the engine itself pushed, because that is the round trip
 * that has to hold: `handle.heads()` is automerge-repo's own encoding
 * (base58check), not the hex hashes Automerge takes. A stand-in handle that
 * returned Automerge's heads passed while every pinned mint in the browser
 * failed.
 */
import * as A from '@automerge/automerge';
import { DriveEngine } from '../src/shared/drive-engine';

const { Repo, decodeHeads } = require('@automerge/automerge-repo');

const FILTER = 'IDENTITY';
const PATH = ['content'];
const BEFORE = 'We hike in on Friday and pitch the tents by the lake.';
const SELECTED = 'and pitch the tents';
const SURVIVES = ' the tents';
/** The same indices, read against the text after the peer's edit. */
const WRONG_TEXT = 'ay night and set up';

const repo = new Repo({ network: [] });
afterAll(async () => { await repo.shutdown(); });

/**
 * An engine with one open document that the page has drawn, and that a peer
 * has since typed over. `shown` is the heads of the push the page drew.
 */
async function peerTypedOver() {
  const emitted: any[] = [];
  const engine = new DriveEngine({
    emit: (e: any) => emitted.push(e),
    kv: { get: async () => null, set: async () => {}, del: async () => {}, delPrefix: async () => {} },
  } as any);
  (engine as any).lastViewedHeads = {};
  (engine as any).jqCache.set(FILTER, (d: any) => JSON.parse(JSON.stringify(d)));
  // What init takes from createKeyhiveRepo.
  (engine as any).Automerge = A;
  (engine as any).decodeHeads = decodeHeads;

  const handle = repo.create({ content: BEFORE });
  const docId = handle.documentId as string;
  (engine as any).getOrCreateEntry(docId, handle);

  await engine.handleMessage({ type: 'subscribe-query', subId: 1, docId, filter: FILTER, spansPath: PATH } as any);
  const push = emitted.filter(e => e.type === 'query-result' && !e.error).at(-1);
  expect(push.result.content).toBe(BEFORE);
  const shown: string[] = push.heads;

  const from = BEFORE.indexOf(SELECTED);
  const selection = [from, from + SELECTED.length];
  // The peer replaces "hike in on Friday and pitch" — the head of the selection goes with it.
  handle.change((d: any) => { A.splice(d, PATH, 3, 27, 'drive up on Thursday night and set up'); });

  let nextId = 1;
  const mint = async (heads?: string[]) => {
    const id = nextId++;
    await engine.handleMessage({ type: 'text-cursors', id, docId, path: PATH, positions: selection, ...(heads ? { heads } : {}) } as any);
    const r = emitted.find(x => x.type === 'result' && x.id === id);
    if (!r) throw new Error('no result for text-cursors');
    if (r.error) throw new Error(r.error);
    return r.result as string[];
  };
  const textBetween = (cursors: string[]) => {
    const doc = handle.doc();
    const [a, b] = cursors.map(c => A.getCursorPosition(doc, PATH, c));
    return (doc.content as string).slice(Math.min(a, b), Math.max(a, b));
  };
  return { handle, shown, mint, textBetween };
}

describe('text-cursors', () => {
  it('pushes heads in the handle\'s encoding, which is not Automerge\'s', async () => {
    const { handle, shown } = await peerTypedOver();
    // The premise of everything below: what a push carries has to be decoded.
    expect(shown).not.toEqual(A.getHeads(A.view(handle.doc(), decodeHeads(shown))));
    expect(() => A.hasHeads(handle.doc(), shown)).toThrow();
  });

  it('mints against the version of the push the caller names, not the newest', async () => {
    const { shown, mint, textBetween } = await peerTypedOver();
    // What is left of the phrase the user selected.
    expect(textBetween(await mint(shown))).toBe(SURVIVES);
  });

  it('without a version, reads the indices against the newest document', async () => {
    const { mint, textBetween } = await peerTypedOver();
    expect(textBetween(await mint())).toBe(WRONG_TEXT);
  });

  it('falls back to the newest document for a version it does not have', async () => {
    const { mint, textBetween } = await peerTypedOver();
    const elsewhere: string[] = repo.create({ content: 'another document' }).heads();
    expect(textBetween(await mint(elsewhere))).toBe(WRONG_TEXT);
  });

  it('falls back to the newest document for heads that are not heads', async () => {
    const { mint, textBetween } = await peerTypedOver();
    expect(textBetween(await mint(['not-heads']))).toBe(WRONG_TEXT);
  });

  it('does not hide a failure of its own: with no decoder the mint fails', async () => {
    // Falling back is for heads that name nothing. An engine that cannot decode
    // heads at all would otherwise fall back on every mint, and look fine.
    const { shown } = await peerTypedOver();
    const emitted: any[] = [];
    const bare = new DriveEngine({
      emit: (e: any) => emitted.push(e),
      kv: { get: async () => null, set: async () => {}, del: async () => {}, delPrefix: async () => {} },
    } as any);
    (bare as any).lastViewedHeads = {};
    (bare as any).Automerge = A;
    const handle = repo.create({ content: BEFORE });
    (bare as any).getOrCreateEntry(handle.documentId, handle);

    await bare.handleMessage({ type: 'text-cursors', id: 1, docId: handle.documentId, path: PATH, positions: [1], heads: shown } as any);
    expect(emitted.find(e => e.type === 'result' && e.id === 1).error).toMatch(/no heads decoder/);
  });
});
