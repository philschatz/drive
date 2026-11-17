/**
 * Every Timeline change function, rebuilt from its source text the way the
 * worker rebuilds an updateDoc callback, and run inside a real Automerge
 * change. This catches what the jsdom mock of updateDoc cannot: a closure or
 * import the rebuilt function no longer sees, an `undefined` value, or a
 * reference to an object already in the document.
 */
import * as Automerge from '@automerge/automerge';
import * as changes from './changes';
import { createTimelineDoc, type TimelineEvent } from '../schemas/timeline';
import { validateDocument } from '../schemas';

/** As the worker does: `new Function('return ' + fnSource)()`. */
const rebuilt = <F extends (...a: any[]) => any>(fn: F): F => new Function('return ' + fn.toString())();

function run<A extends unknown[]>(doc: Automerge.Doc<any>, fn: (d: any, ...a: A) => unknown, ...args: A) {
  const f = rebuilt(fn);
  return Automerge.change(doc, d => { f(d, ...args); });
}

const ev = (title: string, over: Partial<TimelineEvent> = {}): TimelineEvent => ({ '@type': 'Event', title, ...over });
const fresh = () => Automerge.from<any>(createTimelineDoc('Life'));
const plain = (doc: Automerge.Doc<any>) => Automerge.toJS(doc);
const errors = (doc: Automerge.Doc<any>) => validateDocument(plain(doc)).filter(e => e.kind !== 'warning');

describe('timeline changes, rebuilt as the worker rebuilds them', () => {
  it('every export is self-contained', () => {
    for (const [name, fn] of Object.entries(changes)) {
      if (typeof fn !== 'function') continue;
      expect(() => rebuilt(fn as any)).not.toThrow();
      expect(typeof rebuilt(fn as any)).toBe('function');
      expect(name).toBeTruthy();
    }
  });

  it('addEntry, patchEntry, setWhen', () => {
    let doc = run(fresh(), changes.addEntry, 'a', ev('Moved', { description: undefined, location: 'Houston' }));
    expect(plain(doc).events.a).toEqual({ '@type': 'Event', title: 'Moved', location: 'Houston' });
    doc = run(doc, changes.patchEntry, 'a', { revisit: 'ask Mom', location: null });
    expect(plain(doc).events.a).toEqual({ '@type': 'Event', title: 'Moved', revisit: 'ask Mom' });
    doc = run(doc, changes.setWhen, 'a', 'when', { earliest: '2010', latest: '2010', best: undefined } as any, { start: '2010-07-02', duration: 'P1D' });
    expect(plain(doc).events.a).toMatchObject({ when: { earliest: '2010', latest: '2010' }, start: '2010-07-02', duration: 'P1D' });
    doc = run(doc, changes.setWhen, 'a', 'when', null, {});
    expect(plain(doc).events.a.when).toBeUndefined();
    expect(plain(doc).events.a.start).toBeUndefined();
    expect(errors(doc)).toEqual([]);
  });

  it('relations, placement, and delete cleaning up behind itself', () => {
    let doc = run(fresh(), changes.addEntry, 'a', ev('A'));
    doc = run(doc, changes.addEntry, 'b', ev('B'));
    doc = run(doc, changes.answerRelation, 'a', 'rel', 'b', 'before');
    doc = run(doc, changes.answerRelation, 'a', 'rel', 'gone', 'before');
    expect(plain(doc).events.a.rel).toEqual({ b: 'before' });
    doc = run(doc, changes.applyPlacement, 'b',
      [{ owner: 'a', field: 'rel', target: 'b' }],
      [{ owner: 'b', field: 'rel', target: 'a', rel: 'before' }],
      { best: '2010-06' }, { start: '2010-06-15', duration: 'P1D' });
    expect(plain(doc).events.a.rel).toEqual({});
    expect(plain(doc).events.b).toMatchObject({ rel: { a: 'before' }, when: { best: '2010-06' }, start: '2010-06-15' });
    doc = run(doc, changes.removeRelation, 'b', 'rel', 'a');
    doc = run(doc, changes.answerRelation, 'b', 'rel', 'a', 'after');
    doc = run(doc, changes.deleteEntry, 'a');
    expect(plain(doc).events).toEqual({ b: expect.objectContaining({ rel: {} }) });
  });

  it('prompts: answer, dismiss (thumbnails go unless an entry shows them), gaps', () => {
    const link = (h: string) => ({ '@type': 'Link', href: `https://pp.example/${h}`, display: 'thumbnail' });
    let doc = run(fresh(), changes.addPrompts, {
      prompts: {
        'photo-1': { source: 'photos', cover: 'p1', links: { p1: link('1') }, count: 3, added: '2026-11-17T00:00:00.000Z' },
        'photo-2': { source: 'photos', cover: 'p2', links: { p2: link('2') }, count: 1, added: '2026-11-17T00:00:00.000Z' },
      },
      thumbs: { p1: 'QUFB', p2: 'QkJC' },
    } as any, (s: string) => new Automerge.ImmutableString(s));
    expect(Automerge.isImmutableString(doc.thumbs.p1)).toBe(true);

    // The source-built version cannot reach `Automerge` — that is why wrap is passed in.
    doc = run(doc, changes.answerPrompt, 'photo-1', 'e1', ev('Beach day', { links: { p1: link('1') } as any }));
    expect(plain(doc).prompts['photo-1'].entry).toBe('e1');
    doc = run(doc, changes.dismissPrompt, 'photo-2');
    expect(plain(doc).prompts['photo-2'].dismissed).toBe(true);
    expect(plain(doc).thumbs.p2).toBeUndefined();
    doc = run(doc, changes.dismissPrompt, 'photo-1'); // answered: stays answered
    expect(plain(doc).prompts['photo-1'].dismissed).toBeUndefined();

    doc = run(doc, changes.deleteEntry, 'e1');
    expect(plain(doc).prompts['photo-1'].entry).toBeUndefined();

    doc = run(doc, changes.recordGap, 'gap-1', { source: 'gap', when: { earliest: '1995', latest: '2000' }, added: 'x', dismissed: true });
    doc = run(doc, changes.answerGap, 'gap-2', { source: 'gap', when: { earliest: '2001', latest: '2003' }, added: 'x' }, 'e2', ev('Summer job'));
    expect(plain(doc).prompts['gap-2']).toMatchObject({ entry: 'e2' });
    expect(errors(doc)).toEqual([]);
  });

  it('addPrompts never overwrites, and refuses a document of another type', () => {
    const wrap = (s: string) => new Automerge.ImmutableString(s);
    let doc = run(fresh(), changes.addPrompts, { prompts: { k: { source: 'photos', added: 'one' } }, thumbs: { t: 'QUFB' } } as any, wrap);
    doc = run(doc, changes.addPrompts, { prompts: { k: { source: 'photos', added: 'two' } }, thumbs: { t: 'Q0ND' } } as any, wrap);
    expect(plain(doc).prompts.k.added).toBe('one');
    expect(String(doc.thumbs.t)).toBe('QUFB');

    const other = Automerge.from<any>({ '@type': 'Calendar', name: 'x', events: {} });
    const after = run(other, changes.addPrompts, { prompts: { k: { source: 'photos', added: 'x' } }, thumbs: {} } as any, wrap);
    expect(plain(after).prompts).toBeUndefined();
  });

  it('birth and rename', () => {
    let doc = run(fresh(), changes.setBirth, '1987-03-04');
    doc = run(doc, changes.rename, 'My life');
    expect(plain(doc)).toMatchObject({ birth: '1987-03-04', name: 'My life' });
    doc = run(doc, changes.setBirth, null);
    expect(plain(doc).birth).toBeUndefined();
  });
});
