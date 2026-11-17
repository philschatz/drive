import * as Automerge from '@automerge/automerge';
import { validateDocument } from './index';
import { createTimelineDoc, thumbBase64, MAX_THUMB_CHARS, type TimelineDocument } from './timeline';

const entry = (over: Record<string, unknown> = {}) => ({
  '@type': 'Event', title: 'Moved to Houston',
  when: { earliest: '2009', latest: '2011' }, start: '2010-07-02', duration: 'P1D',
  ...over,
});
const docWith = (over: Partial<TimelineDocument> = {}): any => ({ ...createTimelineDoc('Life'), ...over });
const errorsOf = (doc: any) => validateDocument(doc).filter(e => e.kind !== 'warning');
const at = (doc: any) => errorsOf(doc).map(e => e.path.join('.'));

describe('Timeline schema', () => {
  it('a fresh document and a full entry are valid', () => {
    expect(errorsOf(docWith())).toEqual([]);
    const doc = docWith({
      birth: '1987-03-04',
      events: {
        a: entry({
          description: 'Long drive.', location: 'Houston', coordinates: 'geo:29.76,-95.37',
          recall: 'hazy', revisit: 'ask Mom', settled: true, rel: { b: 'after' },
          links: { pq1: { '@type': 'Link', href: 'https://photos.example/library/browse?view=cards&q=uid:pq1', display: 'thumbnail', contentType: 'image/jpeg' } },
        }),
        b: entry({ title: 'High school', when: { earliest: '2001', latest: '2001' }, until: { earliest: '2005', latest: '2005' }, start: '2001-07-02', duration: 'P1461D' }),
        undated: { '@type': 'Event', title: 'A dog called Max' },
      },
      prompts: {
        'photo-pq1': { source: 'photos', when: { earliest: '2010-06-12', latest: '2010-06-12' }, cover: 'pq1', count: 12, added: '2026-11-17T10:00:00.000Z' },
        'gap-1': { source: 'gap', when: { earliest: '1995', latest: '2000' }, added: '2026-11-17T10:00:00.000Z', dismissed: true },
      },
      thumbs: { pq1: 'QUJD', pq2: { val: 'QUJD' } as any },
    });
    expect(errorsOf(doc)).toEqual([]);
    expect(validateDocument(doc).filter(e => e.kind === 'warning')).toEqual([]);
  });

  it('reuses the Calendar validator for the JSCalendar fields', () => {
    const doc = docWith({
      events: {
        a: entry({
          start: '2010-02-30',
          links: { x: { '@type': 'Link', href: 'javascript:alert(1)' } },
          recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'weekly', byMonthDay: [40] },
        }),
      },
    });
    const paths = at(doc);
    expect(paths).toContain('events.a.start');
    expect(paths).toContain('events.a.links.x.href');
    expect(paths.some(p => p.startsWith('events.a.recurrenceRule'))).toBe(true);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['an unreal partial date', { when: { earliest: '2010-02-30', latest: '2011' } }, 'events.a.when.earliest'],
    ['earliest after latest', { when: { earliest: '2012', latest: '2011' }, start: undefined }, 'events.a.when'],
    ['best outside the range', { when: { earliest: '2009', latest: '2011', best: '2015' } }, 'events.a.when.best'],
    ['a period ending before it begins', { until: { earliest: '2001', latest: '2001' } }, 'events.a.until'],
    ['start outside when', { start: '2014-01-01' }, 'events.a.start'],
    ['a self relation', { rel: { a: 'before' } }, 'events.a.rel.a'],
    ['an empty title', { title: '' }, 'events.a.title'],
    ['a bad relation', { rel: { b: 'sideways' } }, 'events.a.rel.b'],
    ['bad coordinates', { coordinates: '29.76,-95.37' }, 'events.a.coordinates'],
  ])('reports %s', (_name, over, path) => {
    expect(at(docWith({ events: { a: entry(over) as any } }))).toContain(path);
  });

  it('checks thumbnails and prompt links', () => {
    const doc = docWith({
      prompts: { p: { source: 'photos', added: 'x', links: { a: { '@type': 'Link', href: 'file:///etc/passwd' } } } as any },
      thumbs: { big: 'A'.repeat(MAX_THUMB_CHARS + 4), bad: 'not base64!' },
    });
    expect(at(doc)).toEqual(expect.arrayContaining(['prompts.p.links.a.href', 'thumbs.big', 'thumbs.bad']));
  });

  it('dangling references are not errors', () => {
    const doc = docWith({
      events: { a: entry({ rel: { gone: 'before' }, untilRel: { gone2: 'after' } }) as any },
      prompts: { p: { source: 'photos', added: 'x', entry: 'gone', cover: 'gone' } },
    });
    expect(errorsOf(doc)).toEqual([]);
  });

  it('accepts a thumbnail stored as an Automerge ImmutableString, before and after cloning', () => {
    let doc = Automerge.from<any>(docWith());
    doc = Automerge.change(doc, d => { d.thumbs.pq1 = new Automerge.ImmutableString('QUJD'); });
    expect(errorsOf(doc)).toEqual([]);
    expect(errorsOf(structuredClone(Automerge.toJS(doc)))).toEqual([]);
    expect(thumbBase64(doc.thumbs.pq1)).toBe('QUJD');
    expect(thumbBase64({ val: 'QUJD' })).toBe('QUJD');
    expect(thumbBase64(null)).toBeNull();
  });
});
