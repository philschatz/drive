import { render, screen, fireEvent, within, waitFor } from '@testing-library/preact';

// The real Timeline container on the in-memory + jq worker-api mock. md-*
// elements are unregistered under jsdom, so MdSelect is a native <select> and
// MdTextField a native <input>, both drivable with fireEvent.input. The mock's
// updateDoc runs callbacks directly; changes.test.ts covers running them the
// way the worker does (rebuilt from source, on real Automerge).
jest.mock('../../worker-api');
import * as api from '../../worker-api';
import { Timeline } from './Timeline';
import { __clearThumbCache } from './Thumb';

const mock = api as any;
const DOC = 'doc-timeline';

// jsdom has no PointerEvent: fireEvent.pointer* would build a bare Event and
// drop clientY. A MouseEvent of the same type carries it to the handlers.
const pointer = (el: Element, type: string, clientY: number) =>
  fireEvent(el, new MouseEvent(type, { bubbles: true, cancelable: true, clientY }));
it('uses the manual worker-api mock', () => expect(mock.__isMock).toBe(true));

const tap = (el: Element) => { fireEvent.pointerDown(el); fireEvent.pointerUp(el); fireEvent.click(el); };
const year = (y: number) => ({ earliest: String(y), latest: String(y) });
const ev = (title: string, over: Record<string, unknown> = {}) => ({ '@type': 'Event', title, ...over });
const base = (over: Record<string, unknown> = {}) => ({
  '@type': 'Calendar+Timeline', name: 'Life', birth: '1987-03-04', events: {}, prompts: {}, thumbs: {}, ...over,
});
const events = () => mock.__getDoc(DOC).events as Record<string, any>;
const titles = () => screen.queryAllByTestId('timeline-row').map(r => r.querySelector('[slot="headline"]')!.textContent);

async function renderTimeline(doc: Record<string, unknown>) {
  mock.__setDoc(DOC, doc);
  render(<Timeline docId={DOC} />);
  await waitFor(() => expect(screen.getByTestId('timeline-tabs')).toBeTruthy());
}
const openTab = (name: RegExp) => fireEvent.click(within(screen.getByTestId('timeline-tabs')).getByRole('tab', { name }));
const close = () => fireEvent.click(screen.getByRole('button', { name: 'Close' }));

describe('Timeline container', () => {
  let writes: jest.SpyInstance;
  beforeEach(() => { mock.__reset(); __clearThumbCache(); writes = jest.spyOn(api, 'updateDoc'); });
  afterEach(() => writes.mockRestore());

  it('lists entries newest first (birth at the bottom) under year headers, with gap rows and an Undated section on top', async () => {
    await renderTimeline(base({
      events: {
        b: ev('Moved to Houston', { when: year(2010), location: 'Houston' }),
        a: ev('Started school', { when: year(1993) }),
        u: ev('A dog called Max'),
        r: ev('Before Houston', { rel: { b: 'before' }, when: { earliest: '2009' } }),
      },
    }));
    expect(titles()).toEqual(['A dog called Max', 'Moved to Houston', 'Before Houston', 'Started school']);
    expect(screen.getAllByTestId('timeline-year').map(s => s.getAttribute('data-year'))).toEqual(['2010', '2009', '1993']);
    expect(screen.getByTestId('timeline-gap').textContent).toContain('1994–2008');
    expect(within(screen.getByTestId('timeline-undated')).getByText('A dog called Max')).toBeTruthy();
  });

  it('adds entries from the FAB; Enter saves and opens the next blank one', async () => {
    await renderTimeline(base());
    fireEvent.click(document.querySelector('md-fab')!);
    fireEvent.input(screen.getByTestId('tl-title'), { target: { value: 'First bike' } });
    fireEvent.keyDown(screen.getByTestId('tl-title'), { key: 'Enter' });
    expect((screen.getByTestId('tl-title') as HTMLInputElement).value).toBe('');
    fireEvent.input(screen.getByTestId('tl-title'), { target: { value: 'Broke my arm' } });
    fireEvent.keyDown(screen.getByTestId('tl-title'), { key: 'Enter' });
    close();
    expect(Object.values(events()).map((e: any) => e.title).sort()).toEqual(['Broke my arm', 'First bike']);
    expect(writes).toHaveBeenCalledTimes(2);
  });

  it('the When pane writes the fuzzy date and the calendar start in one change', async () => {
    await renderTimeline(base({ events: { a: ev('Moved') } }));
    tap(screen.getByText('Moved').closest('[data-testid="timeline-row"]')!);
    fireEvent.click(screen.getByTestId('tl-when-row'));
    fireEvent.input(screen.getByTestId('tl-when-kind'), { target: { value: 'season' } });
    fireEvent.input(screen.getByTestId('tl-when-season'), { target: { value: 'summer' } });
    fireEvent.input(screen.getByTestId('tl-when-year'), { target: { value: '2014' } });
    expect(screen.getByTestId('tl-when-preview').textContent).toBe('summer 2014');
    expect(writes).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('tl-when-save'));
    expect(writes).toHaveBeenCalledTimes(1);
    expect(events().a).toMatchObject({ when: { earliest: '2014-06', latest: '2014-08' }, start: '2014-07-16', duration: 'P1D' });
  });

  it('When and Until keep separate drafts; switching presets keeps what was typed', async () => {
    await renderTimeline(base({ events: { a: ev('College', { when: year(2005) }) } }));
    tap(screen.getByText('College').closest('[data-testid="timeline-row"]')!);
    fireEvent.click(screen.getByTestId('tl-until-row'));
    fireEvent.input(screen.getByTestId('tl-until-kind'), { target: { value: 'year' } });
    fireEvent.input(screen.getByTestId('tl-until-year'), { target: { value: '2009' } });
    fireEvent.input(screen.getByTestId('tl-until-kind'), { target: { value: 'around' } });
    expect((screen.getByTestId('tl-until-year') as HTMLInputElement).value).toBe('2009');
    fireEvent.input(screen.getByTestId('tl-until-kind'), { target: { value: 'year' } });
    fireEvent.click(screen.getByTestId('tl-until-save'));
    expect(events().a.when).toEqual(year(2005));
    expect(events().a.until).toEqual(year(2009));
    expect(events().a.duration).toMatch(/^P\d+D$/);
  });

  it('story, place and revisit are each one change', async () => {
    await renderTimeline(base({ events: { a: ev('Moved', { when: year(2010) }) } }));
    tap(screen.getByText('Moved').closest('[data-testid="timeline-row"]')!);
    fireEvent.click(screen.getByTestId('tl-story-row'));
    fireEvent.input(screen.getByTestId('tl-story'), { target: { value: 'We drove for two days.' } });
    fireEvent.click(screen.getByTestId('tl-story-save'));
    fireEvent.click(screen.getByTestId('tl-revisit-row'));
    fireEvent.input(screen.getByTestId('tl-revisit-note'), { target: { value: 'ask Mom which month' } });
    fireEvent.click(screen.getByTestId('tl-revisit-save'));
    expect(writes).toHaveBeenCalledTimes(2);
    expect(events().a).toMatchObject({ description: 'We drove for two days.', revisit: 'ask Mom which month' });
    close();
    openTab(/Revisit/);
    expect(within(screen.getByTestId('timeline-revisit')).getByText('ask Mom which month')).toBeTruthy();
  });

  it('deletes through the confirm sheet, cleaning up relations to it', async () => {
    await renderTimeline(base({ events: { a: ev('A', { when: year(2010) }), b: ev('B', { rel: { a: 'after' } }) } }));
    tap(screen.getByText('A').closest('[data-testid="timeline-row"]')!);
    fireEvent.click(screen.getByTestId('tl-delete'));
    fireEvent.click(await screen.findByTestId('confirm-accept'));
    await waitFor(() => expect(events().a).toBeUndefined());
    expect(events().b.rel).toEqual({});
  });

  describe('arrange mode', () => {
    const three = () => base({
      events: {
        a: ev('Alpha', { when: year(2010) }),
        b: ev('Bravo', { when: year(2010), rel: { a: 'after' } }),
        c: ev('Charlie', { when: year(2010), rel: { b: 'after' } }),
        x: ev('Exact day', { when: { earliest: '2010-12-20', latest: '2010-12-20' } }),
      },
    });

    it('inserting between two entries is one change holding both relations', async () => {
      await renderTimeline(three());
      fireEvent.click(screen.getByTitle('Arrange'));
      expect(titles()).toEqual(['Exact day', 'Charlie', 'Bravo', 'Alpha']);
      // Targets, top down: after Exact day, Exact–Charlie, Charlie–Bravo, Bravo–Alpha, before Alpha.
      expect(screen.getAllByTestId('timeline-insert').map(b => b.textContent)).toEqual(['addInsert later', 'addInsert here', 'addInsert here', 'addInsert here', 'addInsert earlier']);
      fireEvent.click(screen.getAllByTestId('timeline-insert')[3]);
      fireEvent.input(screen.getByTestId('tl-title'), { target: { value: 'Between' } });
      fireEvent.click(screen.getByTestId('tl-title-save'));
      expect(writes).toHaveBeenCalledTimes(1);
      const created = Object.values(events()).find((e: any) => e.title === 'Between') as any;
      expect(created.rel).toEqual({ a: 'after', b: 'before' });
      expect(created.when.best).toMatch(/^2010/);
      expect(created.start).toMatch(/^2010-/);
      close();
      expect(titles().slice(-3)).toEqual(['Bravo', 'Between', 'Alpha']);
    });

    it('keyboard ↓ on a handle moves an entry down (earlier) one place; exact-day entries have no handle', async () => {
      await renderTimeline(three());
      fireEvent.click(screen.getByTitle('Arrange'));
      expect(screen.queryByTestId('drag-x')).toBeNull();
      fireEvent.keyDown(screen.getByTestId('drag-c'), { key: 'ArrowDown' });
      expect(writes).toHaveBeenCalledTimes(1);
      expect(titles()).toEqual(['Exact day', 'Bravo', 'Charlie', 'Alpha']);
      expect(events().c.rel).toMatchObject({ a: 'after' });
      expect(events().c.rel.b).toBe('before');
    });

    it('keyboard ↑ moves an entry up (later) one place', async () => {
      await renderTimeline(three());
      fireEvent.click(screen.getByTitle('Arrange'));
      fireEvent.keyDown(screen.getByTestId('drag-a'), { key: 'ArrowUp' });
      expect(titles()).toEqual(['Exact day', 'Charlie', 'Alpha', 'Bravo']);
    });

    it('a drag drops an entry where the pointer lets go', async () => {
      await renderTimeline(three());
      fireEvent.click(screen.getByTitle('Arrange'));
      // Row i occupies y = 100i .. 100i+80 (mid 100i+40).
      document.querySelectorAll<HTMLElement>('[data-entry-row]').forEach((r, i) => {
        r.getBoundingClientRect = () => ({ top: i * 100, height: 80, bottom: i * 100 + 80, left: 0, right: 0, width: 0, x: 0, y: i * 100, toJSON: () => ({}) });
      });
      const handle = screen.getByTestId('drag-a');
      pointer(handle, 'pointerdown', 340);
      // Alpha starts at the bottom; let go between Exact day (mid 40) and Charlie (mid 140).
      pointer(handle, 'pointermove', 50);
      pointer(handle, 'pointerup', 50);
      expect(titles()).toEqual(['Exact day', 'Alpha', 'Charlie', 'Bravo']);
    });

    it('a spot the entry\'s date forbids changes nothing and says why', async () => {
      await renderTimeline(base({
        events: {
          a: ev('Alpha', { when: year(2010) }),
          b: ev('Bravo', { when: year(2012) }),
          old: ev('Old', { when: year(2004) }),
        },
      }));
      fireEvent.click(screen.getByTitle('Arrange'));
      fireEvent.keyDown(screen.getByTestId('drag-old'), { key: 'ArrowUp' });
      expect(writes).not.toHaveBeenCalled();
      expect(screen.getByTestId('timeline-move-refused').textContent).toContain('doesn\'t fit between “Alpha” and “Bravo”');
      fireEvent.click(screen.getByTestId('timeline-widen'));
      expect(screen.getByTestId('tl-when-pane')).toBeTruthy();
    });
  });

  describe('chapters', () => {
    const life = () => base({
      events: {
        home: ev('Chicago', { chapter: 'place', when: year(2005) }),
        jamie: ev('Dating Jamie', { chapter: 'people', when: year(2010), until: year(2012) }),
        m1: ev('Met her parents', { when: year(2011) }),
        m2: ev('Adopted a dog', { when: year(2015) }),
      },
    });
    const rowItem = (title: string) => [...document.querySelectorAll('[slot="headline"]')]
      .find(h => h.textContent === title)!.closest('[role="listitem"]')!;
    const cells = (title: string) => {
      const item = rowItem(title);
      return [...item.querySelectorAll<HTMLElement>('[data-chapter]')]
        .map(c => `${c.dataset.chapter}:${c.dataset.lane}:${c.dataset.shape}`);
    };

    it('draws a bar per chapter beside the rows it spans, outer chapters leftmost', async () => {
      await renderTimeline(life());
      expect(screen.getAllByTestId('timeline-chapter-row').map(r => r.getAttribute('data-chapter-kind'))).toEqual(['people', 'place']);
      expect(cells('Adopted a dog')).toEqual(['home:0:through']);
      expect(cells('Met her parents')).toEqual(['home:0:through', 'jamie:1:end']);
      expect(cells('Dating Jamie')).toEqual(['home:0:through', 'jamie:1:start']);
      expect(cells('Chicago')).toEqual(['home:0:start']);
      expect(screen.getByText('Since 2005 · 2 memories')).toBeTruthy();
      expect(screen.getByText('2010 – 2012 · 1 memory')).toBeTruthy();
    });

    it('year headers name the chapters under way that year; tapping a bar opens its chapter', async () => {
      await renderTimeline(life());
      const chips = (y: string) => within(screen.getAllByTestId('timeline-year').find(s => s.getAttribute('data-year') === y)!)
        .queryAllByTestId('year-chapter').map(c => c.textContent);
      expect(chips('2015')).toEqual(['Chicago']);
      expect(chips('2011')).toEqual(['Chicago', 'Dating Jamie']);
      expect(chips('2005')).toEqual(['Chicago']);
      const item = rowItem('Met her parents');
      fireEvent.click(item.querySelector('[data-chapter="jamie"]')!);
      expect(within(screen.getByTestId('timeline-editor')).getAllByText('Dating Jamie').length).toBeGreaterThan(0);
    });

    it('chapters have no drag handle', async () => {
      await renderTimeline(life());
      fireEvent.click(screen.getByTitle('Arrange'));
      expect(screen.queryByTestId('drag-jamie')).toBeNull();
      expect(screen.getByTestId('drag-m1')).toBeTruthy();
    });
  });

  describe('pin down', () => {
    it('asks one question at a time; each answer is one change', async () => {
      await renderTimeline(base({
        events: {
          x: ev('Learned to swim', { when: { earliest: '2000', latest: '2010' } }),
          s: ev('High school', { when: year(2002), until: year(2005) }),
        },
      }));
      openTab(/Pin down/);
      expect(screen.getByTestId('pin-question').textContent).toContain('“Learned to swim” happen before or after “High school”');
      fireEvent.click(screen.getByTestId('pin-during'));
      expect(writes).toHaveBeenCalledTimes(1);
      expect(events().x.rel).toEqual({ s: 'during' });
    });

    it('answers a pivot by narrowing the entry\'s own date; "Not sure" moves on without writing', async () => {
      await renderTimeline(base({ birth: undefined, events: { x: ev('X', { when: { earliest: '2000', latest: '2010' } }) } }));
      openTab(/Pin down/);
      expect(screen.getByTestId('pin-question').textContent).toContain('the start of 2005');
      fireEvent.click(screen.getByTestId('pin-after'));
      expect(events().x.when).toEqual({ earliest: '2005', latest: '2010' });
      fireEvent.click(screen.getByTestId('pin-unsure'));
      expect(screen.getByTestId('pin-done')).toBeTruthy();
      expect(writes).toHaveBeenCalledTimes(1);
    });

    it('lists contradicting answers with a way to remove them', async () => {
      await renderTimeline(base({ events: { a: ev('A', { when: year(2015), rel: { b: 'before' } }), b: ev('B', { when: year(2010) }) } }));
      openTab(/Pin down/);
      const list = screen.getByTestId('pin-conflicts');
      fireEvent.click(within(list).getByRole('button', { name: 'Remove' }));
      expect(events().a.rel).toEqual({});
    });
  });

  describe('prompts', () => {
    const link = { '@type': 'Link', href: 'https://photos.example/library/browse?q=uid:p1', display: 'thumbnail', contentType: 'image/jpeg' };
    const withPrompt = () => base({
      prompts: {
        'photo-p1': { source: 'photos', when: { earliest: '2014-06-12', latest: '2014-06-12' }, location: 'Galveston', links: { p1: link }, cover: 'p1', count: 7, added: '2026-11-17T00:00:00.000Z' },
      },
      thumbs: { p1: 'QUJD' },
    });

    it('shows the thumbnail; Write entry creates the entry and marks the prompt in one change', async () => {
      await renderTimeline(withPrompt());
      openTab(/Prompts/);
      const card = screen.getByTestId('timeline-prompt');
      expect(card.textContent).toContain('Galveston');
      expect(card.textContent).toContain('+6 more photos');
      await waitFor(() => expect(within(card).getByTestId('timeline-thumb').getAttribute('src')).toBe('data:image/jpeg;base64,QUJD'));
      fireEvent.click(within(card).getByTestId('prompt-write'));
      fireEvent.input(screen.getByTestId('tl-title'), { target: { value: 'Beach weekend' } });
      fireEvent.click(screen.getByTestId('tl-title-save'));
      expect(writes).toHaveBeenCalledTimes(1);
      const [uid, entry] = Object.entries(events())[0] as [string, any];
      expect(entry).toMatchObject({ title: 'Beach weekend', location: 'Galveston', start: '2014-06-12', links: { p1: link } });
      expect(mock.__getDoc(DOC).prompts['photo-p1'].entry).toBe(uid);
    });

    it('Skip dismisses the prompt and drops its thumbnail', async () => {
      await renderTimeline(withPrompt());
      openTab(/Prompts/);
      fireEvent.click(screen.getByTestId('prompt-skip'));
      expect(mock.__getDoc(DOC).prompts['photo-p1'].dismissed).toBe(true);
      expect(mock.__getDoc(DOC).thumbs.p1).toBeUndefined();
      expect(screen.queryByTestId('timeline-prompt')).toBeNull();
    });

    it('gap cards: "Nothing comes to mind" records the gap so it is split, not asked again', async () => {
      await renderTimeline(base({ events: { a: ev('A', { when: year(2000) }), b: ev('B', { when: year(2020) }) } }));
      openTab(/Prompts/);
      const first = screen.getAllByTestId('timeline-gap-card')[0].textContent;
      expect(first).toContain('Nothing between');
      fireEvent.click(screen.getAllByTestId('gap-nothing')[0]);
      const recorded = Object.values(mock.__getDoc(DOC).prompts) as any[];
      expect(recorded).toEqual([expect.objectContaining({ source: 'gap', dismissed: true })]);
      expect(screen.getAllByTestId('timeline-gap-card')[0].textContent).not.toBe(first);
    });
  });

  it('read-only: no FAB, no arrange, rows still open', async () => {
    mock.__setDoc(DOC, base({ events: { a: ev('A', { when: year(2010) }) } }));
    render(<Timeline docId={DOC} readOnly />);
    await waitFor(() => expect(screen.getByTestId('timeline-tabs')).toBeTruthy());
    expect(document.querySelector('md-fab')).toBeNull();
    expect(screen.queryByTitle('Arrange')).toBeNull();
  });
});
