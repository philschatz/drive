import 'temporal-polyfill/global';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/preact';

// In-memory + jq mock so the real Counters container runs in jsdom (single
// browser, no peers). Schedule variety is seeded directly via __setDoc; the
// default-Daily FAB-add path is still exercised live, and the editor's own panes
// are driven in CounterEditor.test.tsx. md-* custom elements are NOT registered
// here, so rows are inert hosts driven by their own handlers.
jest.mock('../../worker-api');
import * as api from '../../worker-api';
import { Counters, counterIcon } from './Counters';

const mock = api as any;

// Guards the positional __mocks__ resolution: if src/client/ui/__mocks__/ ever
// drifts away from worker-api.ts, jest.mock() above silently loads the real
// module and every assertion below fails for an unrelated-looking reason.
it('uses the manual worker-api mock', () => expect(mock.__isMock).toBe(true));
const DOC = 'doc-counters';
const rowOf = (title: string) => screen.getByText(title).closest('[data-status]') as HTMLElement;
// The Done section rests collapsed to a count — its rows are not in the DOM
// until the heading's disclosure button is tapped.
const expandDone = () => fireEvent.click(screen.getByRole('button', { name: /^Done \(\d+\)$/ }));

const dailyHabit = (title: string, start = '2026-07-01') => ({
  '@type': 'Event', title, start,
  recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily' },
});

describe('Counters container', () => {
  beforeEach(() => { mock.__reset(); });

  it('adds a daily habit via the FAB and records a completion by tapping the row', async () => {
    mock.__setDoc(DOC, { '@type': 'Calendar+Counters', name: 'Test Counters', events: {} });
    render(<Counters docId={DOC} />);
    await waitFor(() => expect(document.querySelector('md-fab')).toBeTruthy());

    // The met/missed chart lives in a sheet behind the title-bar overflow's
    // "Chart" item (the md-menu is inert in jsdom, so the item is reachable
    // directly) and renders even when empty.
    expect(document.querySelector('svg[aria-label="Met vs missed occurrences per week"]')).toBeNull();
    fireEvent.click(screen.getByTitle('Chart'));
    expect(document.querySelector('svg[aria-label="Met vs missed occurrences per week"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    // FAB → New Counter sheet; Enter saves and chains to a fresh blank
    // counter; dismiss the sheet with its Close button.
    fireEvent.click(document.querySelector('md-fab')!);
    expect(screen.getByText('New Counter')).toBeTruthy();
    const input = screen.getByTestId('ced-title');
    fireEvent.input(input, { target: { value: 'Stretch' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect((screen.getByTestId('ced-title') as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    // New counters default to Daily → due today ("To do").
    expect(screen.getByRole('heading', { name: 'To do' })).toBeTruthy();
    expect(rowOf('Stretch').getAttribute('data-status')).toBe('due');

    // Tapping the row records a completion → moves to "Done", which rests
    // collapsed: the row leaves the DOM and the heading carries the count.
    fireEvent.click(rowOf('Stretch'));
    expect(screen.queryByText('Stretch')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Done (1)' })).toBeTruthy();
    // Expanded, the row is done. A single-day streak is not a streak yet: the
    // flame badge only renders once the streak reaches 2+ (recurring items show
    // a streak, not a total).
    expandDone();
    expect(rowOf('Stretch').getAttribute('data-status')).toBe('done');
    expect(within(rowOf('Stretch')).queryByTitle('1-day streak')).toBeNull();

    // Tapping is the primary action, so a second tap adds another completion
    // (streak stays 1: same day) rather than opening the editor.
    fireEvent.click(rowOf('Stretch'));
    expect(screen.queryByText('Edit Counter')).toBeNull();
    const events = mock.__getDoc(DOC).events as Record<string, any>;
    const uid = Object.keys(events).find(k => events[k].title === 'Stretch')!;
    expect(Object.keys(events[uid].completions).length).toBe(2);
    expect(within(rowOf('Stretch')).queryByTitle('1-day streak')).toBeNull();

    // A hold (proxied by right-click) opens the editor instead — and must NOT
    // record another completion.
    fireEvent.contextMenu(rowOf('Stretch'));
    expect(screen.getByText('Edit Counter')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(Object.keys(mock.__getDoc(DOC).events[uid].completions).length).toBe(2);
  });

  it('archives (via the editor) and unarchives a recurring habit', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    mock.__setDoc(DOC, { '@type': 'Calendar+Counters', name: 'C', events: { e1: dailyHabit('Meditate') } });
    render(<Counters docId={DOC} />);
    await waitFor(() => expect(screen.getByText('Meditate')).toBeTruthy());

    // Archive lives in the editor: open it by holding the row (right-click is
    // the same secondary gesture), then Archive. It's an md-list-item, which
    // carries no implicit role while unregistered under jsdom — address it by
    // testid.
    fireEvent.contextMenu(rowOf('Meditate'));
    fireEvent.click(screen.getByTestId('ced-archive'));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('heading', { name: 'Archived' })).toBeTruthy();
    // It's now in the Archived section — no longer a status row in the active list.
    expect(screen.getByText('Meditate').closest('[data-status]')).toBeNull();

    // Unarchive asks first — retiring a habit is deliberate, so resurrecting it
    // shouldn't ride on one stray tap. Cancelling leaves it archived.
    fireEvent.click(screen.getByRole('button', { name: 'Unarchive' }));
    fireEvent.click(await screen.findByTestId('confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('confirm-sheet')).toBeNull());
    expect(screen.getByRole('heading', { name: 'Archived' })).toBeTruthy();

    // Accepting brings it back to the active list.
    fireEvent.click(screen.getByRole('button', { name: 'Unarchive' }));
    fireEvent.click(await screen.findByTestId('confirm-accept'));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Archived' })).toBeNull());
    confirmSpy.mockRestore();
  });

  it('asks the same question when the archived row is held', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    mock.__setDoc(DOC, { '@type': 'Calendar+Counters', name: 'C', events: { e1: dailyHabit('Meditate') } });
    render(<Counters docId={DOC} />);
    await waitFor(() => expect(screen.getByText('Meditate')).toBeTruthy());

    fireEvent.contextMenu(rowOf('Meditate'));
    fireEvent.click(screen.getByTestId('ced-archive'));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    // Unarchive is the archived row's ONE secondary action, so holding the row
    // runs it — reaching the same confirm the trailing icon does.
    fireEvent.contextMenu(screen.getByTestId('archived-row'), { button: 2 });
    fireEvent.click(await screen.findByTestId('confirm-accept'));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Archived' })).toBeNull());
    confirmSpy.mockRestore();
  });

  it('opens the editor via right-click, Shift+F10, and the trailing kebab', async () => {
    mock.__setDoc(DOC, { '@type': 'Calendar+Counters', name: 'C', events: { e1: dailyHabit('Meditate') } });
    render(<Counters docId={DOC} />);
    await waitFor(() => expect(screen.getByText('Meditate')).toBeTruthy());

    fireEvent.contextMenu(rowOf('Meditate'));
    expect(screen.getByText('Edit Counter')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    fireEvent.keyDown(rowOf('Meditate'), { key: 'F10', shiftKey: true });
    expect(screen.getByText('Edit Counter')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    // The row kebab is a real menu now (Edit / Completions) — md-menu is
    // unregistered under jsdom, so its items are always in the DOM. Picking
    // Edit opens the editor and must not record a completion.
    fireEvent.click(within(rowOf('Meditate')).getByTitle('Edit Meditate'));
    expect(screen.getByText('Edit Counter')).toBeTruthy();
    expect(mock.__getDoc(DOC).events.e1.completions).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    // …and Completions opens the log in its own sheet.
    fireEvent.click(within(rowOf('Meditate')).getByTitle('Completions for Meditate'));
    expect(screen.getByTestId('completions-sheet')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Completions (0)' })).toBeTruthy();
  });

  it('shows the flame streak badge once a recurring habit has a 2+ day streak', async () => {
    const today = Temporal.Now.plainDateISO().toString();
    const yesterday = Temporal.Now.plainDateISO().subtract({ days: 1 }).toString();
    mock.__setDoc(DOC, {
      '@type': 'Calendar+Counters', name: 'C',
      events: {
        e1: {
          '@type': 'Event', title: 'Meditate',
          recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily' },
          completions: { [`${yesterday}T09:00:00`]: '', [`${today}T09:00:00`]: '' },
        },
      },
    });
    render(<Counters docId={DOC} />);
    // Done today, so it rests in the collapsed Done section.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Done (1)' })).toBeTruthy());
    expandDone();
    expect(within(rowOf('Meditate')).getByTitle('2-day streak')).toBeTruthy();
  });

  it('recording moves the schedule anchor to the day it was done', async () => {
    const today = Temporal.Now.plainDateISO().toString();
    const sixDaysAgo = Temporal.Now.plainDateISO().subtract({ days: 6 }).toString();
    const created = Temporal.PlainDateTime.from(sixDaysAgo + 'T09:00:00')
      .toZonedDateTime(Temporal.Now.timeZoneId()).toInstant().toString({ smallestUnit: 'second' });
    mock.__setDoc(DOC, {
      '@type': 'Calendar+Counters', name: 'C',
      events: {
        e1: {
          '@type': 'Event', title: 'Water plants', created,
          recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily', interval: 3 },
        },
      },
    });
    render(<Counters docId={DOC} />);
    await waitFor(() => expect(screen.getByText('Water plants')).toBeTruthy());
    expect(rowOf('Water plants').getAttribute('data-status')).toBe('overdue');

    fireEvent.click(rowOf('Water plants'));
    // The recurrence restarts from today; `created` is untouched, so the habit's
    // history (and the chart) still runs from when it was made.
    expect(mock.__getDoc(DOC).events.e1.start).toBe(today);
    expect(mock.__getDoc(DOC).events.e1.created).toBe(created);
    expandDone();
    expect(rowOf('Water plants').getAttribute('data-status')).toBe('done');
  });

  it('a habit written before `created` existed keeps its history when first recorded', async () => {
    const today = Temporal.Now.plainDateISO().toString();
    const d = (n: number) => Temporal.Now.plainDateISO().subtract({ days: n }).toString();
    mock.__setDoc(DOC, {
      '@type': 'Calendar+Counters', name: 'C',
      events: {
        // Legacy shape: `start` is the creation anchor and there is no `created`.
        e1: {
          '@type': 'Event', title: 'Meditate', start: d(10),
          recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily' },
          completions: { [`${d(2)}T09:00:00`]: '', [`${d(1)}T09:00:00`]: '' },
        },
      },
    });
    render(<Counters docId={DOC} />);
    await waitFor(() => expect(screen.getByText('Meditate')).toBeTruthy());

    fireEvent.click(rowOf('Meditate'));
    const ev = mock.__getDoc(DOC).events.e1;
    expect(ev.start).toBe(today); // the anchor moved…
    expect(ev.created.substring(0, 10)).toBe(d(10)); // …and the origin was preserved
    // Three days in a row, so the flame keeps counting across the re-anchor.
    expandDone();
    expect(within(rowOf('Meditate')).getByTitle('3-day streak')).toBeTruthy();
  });

  it('deleting a completion rewinds the schedule anchor to the one before it', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    const d = (n: number) => Temporal.Now.plainDateISO().subtract({ days: n }).toString();
    mock.__setDoc(DOC, {
      '@type': 'Calendar+Counters', name: 'C',
      events: {
        // Done TODAY: deterministic whatever the wall clock — a completion a day
        // or more old can already be past the midpoint to the next occurrence,
        // which would park this row as an upcoming todo some afternoons.
        e1: {
          '@type': 'Event', title: 'Water plants', created: `${d(9)}T09:00:00Z`, start: d(0),
          recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily', interval: 3 },
          completions: { [`${d(3)}T09:00:00`]: '', [`${d(0)}T09:00:00`]: '' },
        },
      },
    });
    render(<Counters docId={DOC} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Done (1)' })).toBeTruthy());
    expandDone();

    fireEvent.click(within(rowOf('Water plants')).getByTitle('Completions for Water plants'));
    // Newest first, so the first delete button is today's mis-click.
    fireEvent.click(within(screen.getByTestId('completions-sheet')).getAllByTitle('Delete completion')[0]);
    expect(mock.__getDoc(DOC).events.e1.start).toBe(d(3));
    confirmSpy.mockRestore();
  });

  it('overdue and to-do rows show the clock, not the recurrence', async () => {
    const d = (n: number) => Temporal.Now.plainDateISO().subtract({ days: n }).toString();
    mock.__setDoc(DOC, {
      '@type': 'Calendar+Counters', name: 'C',
      events: {
        // Created 10 days ago, never done → overdue, and today's all-day window
        // is still OPEN, which is the case whose deadline lies in the future.
        e1: dailyHabit('Meditate', d(10)),
        // Done yesterday, today's window open → pending.
        e2: { ...dailyHabit('Stretch', d(5)), completions: { [`${d(1)}T09:00:00`]: '' } },
      },
    });
    render(<Counters docId={DOC} />);
    await waitFor(() => expect(screen.getByText('Meditate')).toBeTruthy());

    const overdue = within(rowOf('Meditate')).getByTestId('counter-due');
    expect(overdue.textContent).toMatch(/^\d+ days overdue$/);
    expect(overdue.textContent!.startsWith('in ')).toBe(false); // never a future time
    // The recurrence left the badge for the tooltip.
    expect(within(rowOf('Meditate')).queryByText('daily')).toBeNull();
    expect(overdue.getAttribute('title')).toContain('daily');
    expect(overdue.getAttribute('title')).toContain('overdue since');

    expect(within(rowOf('Stretch')).getByTestId('counter-due').textContent).toMatch(/ left$/);

    // Recording it flips the row to Done, which answers "how recently?" — the
    // recurrence stays in the tooltip there too, never back in the badge.
    fireEvent.click(rowOf('Stretch'));
    expandDone();
    expect(rowOf('Stretch').getAttribute('data-status')).toBe('done');
    expect(within(rowOf('Stretch')).queryByTestId('counter-due')).toBeNull();
    const done = within(rowOf('Stretch')).getByTestId('counter-completed');
    expect(done.textContent).toMatch(/ago$/);
    expect(within(rowOf('Stretch')).queryByText('daily')).toBeNull();
    expect(done.getAttribute('title')).toContain('daily');
    expect(done.getAttribute('title')).toContain('completed');
  });

  it('a long-interval habit made two days ago is To do, not Overdue', async () => {
    // The reported bug: a 4-monthly counter went red the morning after it was
    // made, because a window with no explicit duration ended at midnight.
    const created = Temporal.Now.zonedDateTimeISO().subtract({ days: 2 })
      .toInstant().toString({ smallestUnit: 'second' });
    mock.__setDoc(DOC, {
      '@type': 'Calendar+Counters', name: 'C',
      events: {
        e1: {
          '@type': 'Event', title: 'Descale the kettle', created,
          recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'monthly', interval: 4 },
        },
      },
    });
    render(<Counters docId={DOC} />);
    await waitFor(() => expect(screen.getByText('Descale the kettle')).toBeTruthy());

    expect(rowOf('Descale the kettle').getAttribute('data-status')).toBe('due');
    expect(screen.getByRole('heading', { name: 'To do' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Overdue' })).toBeNull();
    // …and the clock counts down to the next occurrence, months out.
    const due = within(rowOf('Descale the kettle')).getByTestId('counter-due');
    expect(due.textContent).toMatch(/ left$/);
    expect(due.getAttribute('title')).toContain('due by');
  });

  it('an overdue habit shows no streak flame — the chain is broken', async () => {
    const d = (n: number) => Temporal.Now.plainDateISO().subtract({ days: n }).toString();
    const done = (...days: number[]) =>
      Object.fromEntries(days.map(n => [`${d(n)}T08:30:00`, '']));
    mock.__setDoc(DOC, {
      '@type': 'Calendar+Counters', name: 'C',
      events: {
        // A timed habit done three days running, whose window shut unmet today.
        e1: {
          '@type': 'Event', title: 'Meditate', start: d(10), startTime: '00:01:00', duration: 'PT1M',
          recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily' },
          completions: done(3, 2, 1),
        },
      },
    });
    render(<Counters docId={DOC} />);
    await waitFor(() => expect(screen.getByText('Meditate')).toBeTruthy());
    expect(rowOf('Meditate').getAttribute('data-status')).toBe('overdue');
    expect(within(rowOf('Meditate')).queryByTitle(/streak/)).toBeNull();
  });

  it('Done rests collapsed to a count and the heading discloses it', async () => {
    const today = Temporal.Now.plainDateISO().toString();
    mock.__setDoc(DOC, {
      '@type': 'Calendar+Counters', name: 'C',
      events: {
        e1: { ...dailyHabit('Meditate'), completions: { [`${today}T08:00:00`]: '' } },
        e2: dailyHabit('Stretch', today),
      },
    });
    render(<Counters docId={DOC} />);
    await waitFor(() => expect(screen.getByText('Stretch')).toBeTruthy());

    // Collapsed by default: the heading carries the count, the rows stay out of
    // the DOM — Done is a shelf of recent wins, not the working list.
    expect(screen.getByRole('heading', { name: 'Done (1)' })).toBeTruthy();
    expect(screen.queryByText('Meditate')).toBeNull();
    const disclosure = screen.getByRole('button', { name: 'Done (1)' });
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(disclosure);
    expect(rowOf('Meditate').getAttribute('data-status')).toBe('done');
    expect(screen.getByRole('button', { name: 'Done (1)' }).getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Done (1)' }));
    expect(screen.queryByText('Meditate')).toBeNull();
  });

  it('a habit past halfway to its next occurrence is To do again, counting down', async () => {
    const d = (n: number) => Temporal.Now.plainDateISO().subtract({ days: n }).toString();
    mock.__setDoc(DOC, {
      '@type': 'Calendar+Counters', name: 'C',
      events: {
        // Every 3 days, done 2 days ago → due again tomorrow: past the midpoint.
        e1: {
          '@type': 'Event', title: 'Water plants', start: d(2),
          recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily', interval: 3 },
          completions: { [`${d(2)}T09:00:00`]: '' },
        },
      },
    });
    render(<Counters docId={DOC} />);
    await waitFor(() => expect(screen.getByText('Water plants')).toBeTruthy());

    // Back on the list ahead of its deadline — muted, empty circle — and the
    // clock badge counts down to when it comes due, not "every 3 days".
    expect(rowOf('Water plants').getAttribute('data-status')).toBe('todo');
    expect(screen.getByRole('heading', { name: 'To do' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /^Done/ })).toBeNull();
    const due = within(rowOf('Water plants')).getByTestId('counter-due');
    expect(due.textContent).toMatch(/^in /);
    expect(due.getAttribute('title')).toMatch(/ · due \d{4}-\d\d-\d\d/);

    // Tapping records → done again, resting in the (collapsed) Done section.
    fireEvent.click(rowOf('Water plants'));
    expect(screen.getByRole('heading', { name: 'Done (1)' })).toBeTruthy();
    expect(screen.queryByText('Water plants')).toBeNull();
  });

  it('non-recurring tallies keep the lifetime N× badge', async () => {
    mock.__setDoc(DOC, {
      '@type': 'Calendar+Counters', name: 'C',
      events: {
        e1: { '@type': 'Event', title: 'Pushups', completions: { '2026-07-19T09:00:00': '', '2026-07-20T09:00:00': '' } },
        e2: { '@type': 'Event', title: 'Never done' },
      },
    });
    render(<Counters docId={DOC} />);
    await waitFor(() => expect(screen.getByText('Pushups')).toBeTruthy());
    expect(within(rowOf('Pushups')).getByText('2×')).toBeTruthy();
    // A settled row answers "how recently?" off its newest completion, exactly
    // like a Done one — and with none ever recorded, it stays quiet.
    const badge = within(rowOf('Pushups')).getByTestId('counter-completed');
    expect(badge.textContent).toMatch(/ago$/);
    expect(badge.getAttribute('title')).toBe('completed 2026-07-20 09:00');
    expect(within(rowOf('Never done')).queryByTestId('counter-completed')).toBeNull();
  });
});

describe('counterIcon', () => {
  // Shape = kind, fill = is anything owed, tone = urgency. Every cell of the
  // matrix is pinned here rather than re-derived from whatever the DOM renders.
  const MATRIX = [
    // Recurring is a circle in every state, including overdue — the tone carries
    // the alarm, and an error glyph would drop the affordance saying "tap me".
    ['recurring', 'overdue', 'radio_button_unchecked', 'error'],
    ['recurring', 'due', 'radio_button_unchecked', 'primary'],
    ['recurring', 'todo', 'radio_button_unchecked', 'muted'],
    ['recurring', 'done', 'check_circle', 'primary'],
    // Checklist is a box in every state…
    ['checklist', 'overdue', 'check_box_outline_blank', 'error'],
    ['checklist', 'due', 'check_box_outline_blank', 'primary'],
    ['checklist', 'todo', 'check_box_outline_blank', 'muted'],
    // …empty while it owes you something, ticked once it doesn't. `anytime` is
    // the resting state a completion settles into: still a box, never a tally.
    ['checklist', 'done', 'check_box', 'primary'],
    ['checklist', 'anytime', 'check_box', 'muted'],
  ] as const;

  it.each(MATRIX)('%s + %s → %s', (kind, status, icon, tone) => {
    expect(counterIcon(kind, status)).toEqual({ icon, tone });
  });

  // The invariant that makes the design self-enforcing, and the one that would
  // have caught the collisions this pass exists to fix: nine cells collapsed
  // into six appearances because kind and time shared a channel. Any future
  // state that reuses an appearance fails here.
  it('gives every cell a distinct appearance', () => {
    const looks = MATRIX.map(([kind, status]) => {
      const { icon, tone } = counterIcon(kind, status);
      return `${icon}/${tone}`;
    });
    expect(new Set(looks).size).toBe(MATRIX.length);
  });

  it('reads the three channels independently', () => {
    // Shape depends only on the kind, holding owed-ness fixed…
    for (const status of ['overdue', 'due', 'todo'] as const) {
      expect(counterIcon('checklist', status).icon).toBe('check_box_outline_blank');
      expect(counterIcon('recurring', status).icon).toBe('radio_button_unchecked');
    }
    // …fill only on whether anything is owed…
    expect(counterIcon('checklist', 'done').icon).toBe('check_box');
    expect(counterIcon('checklist', 'anytime').icon).toBe('check_box');
    // …and tone only on the status, whatever the kind.
    for (const kind of ['checklist', 'recurring'] as const) {
      expect(counterIcon(kind, 'overdue').tone).toBe('error');
      expect(counterIcon(kind, 'due').tone).toBe('primary');
      expect(counterIcon(kind, 'todo').tone).toBe('muted');
    }
  });
});

describe('one-off to-dos', () => {
  beforeEach(() => { mock.__reset(); });

  const today = () => Temporal.Now.plainDateISO().toString();
  const glyphOf = (title: string) => rowOf(title).querySelector('.material-symbols-outlined')!.textContent;

  const seed = (ev: Record<string, unknown>) => mock.__setDoc(DOC, {
    '@type': 'Calendar+Counters', name: 'C',
    events: { e1: { '@type': 'Event', title: 'Buy chocolate', ...ev } },
  });

  it('taps as a checkbox: untick to want it, tick to have done it', async () => {
    seed({ completions: { '2026-07-19T09:00:00': '' } });
    render(<Counters docId={DOC} />);
    await waitFor(() => expect(screen.getByText('Buy chocolate')).toBeTruthy());

    // Settled: nothing owed, so it sits under Anytime wearing a TICKED box. It
    // stays a checklist item rather than turning into a counter — that identity
    // is what makes the same event reusable.
    expect(rowOf('Buy chocolate').getAttribute('data-status')).toBe('anytime');
    expect(screen.getByRole('heading', { name: 'Anytime' })).toBeTruthy();
    expect(glyphOf('Buy chocolate')).toBe('check_box');

    // Untick: `start` is the box, so a tap arms it and nothing else. In
    // particular it records NOTHING — wanting a thing again is not a claim that
    // you did it.
    fireEvent.click(rowOf('Buy chocolate'));
    // A datetime, not a bare date: arming means "as of now", so a completion from
    // earlier today cannot satisfy it and tick the row straight back.
    expect(mock.__getDoc(DOC).events.e1.start).toMatch(new RegExp(`^${today()}T`));
    expect(Object.keys(mock.__getDoc(DOC).events.e1.completions).length).toBe(1);
    expect(rowOf('Buy chocolate').getAttribute('data-status')).toBe('due');
    expect(screen.getByRole('heading', { name: 'To do' })).toBeTruthy();
    expect(glyphOf('Buy chocolate')).toBe('check_box_outline_blank');

    // Tick: logs the completion AND clears the date, so the same event is
    // reusable rather than stuck in Done.
    fireEvent.click(rowOf('Buy chocolate'));
    const ev = mock.__getDoc(DOC).events.e1;
    expect(ev.start).toBeUndefined();
    expect(Object.keys(ev.completions).length).toBe(2);
    expect(rowOf('Buy chocolate').getAttribute('data-status')).toBe('anytime');
    expect(glyphOf('Buy chocolate')).toBe('check_box');
    // The lifetime count is what survives the cycle.
    expect(within(rowOf('Buy chocolate')).getByText('2×')).toBeTruthy();
  });

  it('"Record" counts one without touching the box', async () => {
    seed({ completions: { '2026-07-19T09:00:00': '' } });
    render(<Counters docId={DOC} />);
    await waitFor(() => expect(screen.getByText('Buy chocolate')).toBeTruthy());

    // The tap is a checkbox now, so this is how you log something you just did
    // without first pretending to want it.
    fireEvent.click(within(rowOf('Buy chocolate')).getByTitle('Record one Buy chocolate'));
    let ev = mock.__getDoc(DOC).events.e1;
    expect(Object.keys(ev.completions).length).toBe(2);
    expect(ev.start).toBeUndefined(); // still settled
    expect(rowOf('Buy chocolate').getAttribute('data-status')).toBe('anytime');

    // It disappears once something IS owed: ticking already means "counted it",
    // and recording without clearing `start` would put a completion inside an
    // open window — which reads as done and would stick that way for good.
    fireEvent.click(rowOf('Buy chocolate')); // arm
    // Owed, not done — which is the point. The exact status is `todo` rather
    // than `due` only because arming in the same second as the completion above
    // steps the arm one second past it; a second later it is `due`.
    expect(glyphOf('Buy chocolate')).toBe('check_box_outline_blank');
    expect(screen.getByRole('heading', { name: 'To do' })).toBeTruthy();
    expect(within(rowOf('Buy chocolate')).queryByTitle('Record one Buy chocolate')).toBeNull();
  });

  it('arming is not satisfied by something already recorded today', async () => {
    // The collision the arm timestamp exists for: a completion logged earlier
    // wants no credit against a want expressed after it, or the row would tick
    // itself straight back to Anytime.
    seed({});
    render(<Counters docId={DOC} />);
    await waitFor(() => expect(screen.getByText('Buy chocolate')).toBeTruthy());

    fireEvent.click(within(rowOf('Buy chocolate')).getByTitle('Record one Buy chocolate'));
    fireEvent.click(rowOf('Buy chocolate')); // arm, same second as that completion
    const ev = mock.__getDoc(DOC).events.e1;
    expect(ev.start > Object.keys(ev.completions)[0]).toBe(true);
    expect(rowOf('Buy chocolate').getAttribute('data-status')).not.toBe('anytime');
    expect(glyphOf('Buy chocolate')).toBe('check_box_outline_blank');
  });

  it('a habit has no Record action — its tap already only records', async () => {
    mock.__setDoc(DOC, {
      '@type': 'Calendar+Counters', name: 'C',
      events: { e1: dailyHabit('Stretch', Temporal.Now.plainDateISO().subtract({ days: 1 }).toString()) },
    });
    render(<Counters docId={DOC} />);
    await waitFor(() => expect(screen.getByText('Stretch')).toBeTruthy());
    expect(within(rowOf('Stretch')).queryByTitle('Record one Stretch')).toBeNull();

    // And a habit's tap is never an arm: `start` moves to today rather than the
    // row toggling off the list.
    fireEvent.click(rowOf('Stretch'));
    expect(mock.__getDoc(DOC).events.e1.start).toBe(today());
    expandDone();
    expect(rowOf('Stretch').getAttribute('data-status')).toBe('done');
  });

  it('sits in the same To do section as a habit, ordered by deadline', async () => {
    const d = (n: number) => Temporal.Now.plainDateISO().add({ days: n }).toString();
    mock.__setDoc(DOC, {
      '@type': 'Calendar+Counters', name: 'C',
      events: {
        // Armed a week out: owed, but its window has not opened yet.
        far: { '@type': 'Event', title: 'Book flights', start: d(7) },
        // Armed today with a two-day window, so its deadline is the day after
        // the habit's — which is the only thing that decides their order.
        near: { '@type': 'Event', title: 'Buy milk', start: d(0), duration: 'P2D' },
        // Done yesterday, so today's window is open rather than already missed.
        habit: { ...dailyHabit('Stretch', d(-1)), completions: { [`${d(-1)}T09:00:00`]: '' } },
      },
    });
    render(<Counters docId={DOC} />);
    await waitFor(() => expect(screen.getByText('Book flights')).toBeTruthy());

    // One owed section, not two — a habit and both checklist items share it.
    expect(screen.getAllByRole('heading', { name: 'To do' })).toHaveLength(1);
    expect(rowOf('Stretch').getAttribute('data-status')).toBe('due');
    expect(rowOf('Buy milk').getAttribute('data-status')).toBe('due');
    // Still owed, but not yet actionable: same empty box, muted rather than full.
    expect(rowOf('Book flights').getAttribute('data-status')).toBe('todo');
    // Shape still separates the kinds inside the merged section.
    expect(glyphOf('Buy milk')).toBe('check_box_outline_blank');
    expect(glyphOf('Stretch')).toBe('radio_button_unchecked');
    // Ordered purely by deadline, so the habit lands BETWEEN the two checklist
    // items rather than status or kind clumping them.
    // Direct children only: the kebab's own menu items also carry slot="headline".
    const titles = Array.from(document.querySelectorAll('[data-testid="counter-row"] > [slot="headline"]'))
      .map(n => n.textContent);
    expect(titles).toEqual(['Stretch', 'Buy milk', 'Book flights']);
  });

  it('"Not now" takes it off the list without recording anything', async () => {
    seed({ start: today() });
    render(<Counters docId={DOC} />);
    await waitFor(() => expect(screen.getByText('Buy chocolate')).toBeTruthy());
    expect(rowOf('Buy chocolate').getAttribute('data-status')).toBe('due');

    fireEvent.click(within(rowOf('Buy chocolate')).getByTitle('Take Buy chocolate off To do'));
    const ev = mock.__getDoc(DOC).events.e1;
    expect(ev.start).toBeUndefined();
    expect(ev.completions).toBeUndefined(); // disarming is not doing
    expect(rowOf('Buy chocolate').getAttribute('data-status')).toBe('anytime');
  });

  it('goes overdue once its day passes, keeping the checkbox and gaining the clock', async () => {
    seed({ start: Temporal.Now.plainDateISO().subtract({ days: 3 }).toString() });
    render(<Counters docId={DOC} />);
    await waitFor(() => expect(screen.getByText('Buy chocolate')).toBeTruthy());

    expect(rowOf('Buy chocolate').getAttribute('data-status')).toBe('overdue');
    expect(glyphOf('Buy chocolate')).toBe('check_box_outline_blank');
    expect(within(rowOf('Buy chocolate')).getByTestId('counter-due').textContent).toMatch(/overdue$/);
  });

  it('a recurring habit is untouched by the arm/disarm actions', async () => {
    mock.__setDoc(DOC, {
      '@type': 'Calendar+Counters', name: 'C',
      events: { e1: dailyHabit('Stretch', Temporal.Now.plainDateISO().subtract({ days: 5 }).toString()) },
    });
    render(<Counters docId={DOC} />);
    await waitFor(() => expect(screen.getByText('Stretch')).toBeTruthy());

    // A habit is always on its own schedule — there is no list to add it to.
    expect(within(rowOf('Stretch')).queryByTitle(/To do$/)).toBeNull();
    // And its `start` is a schedule anchor, so a tap moves it rather than clearing it.
    fireEvent.click(rowOf('Stretch'));
    expect(mock.__getDoc(DOC).events.e1.start).toBe(today());
  });
});
