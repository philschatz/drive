import 'temporal-polyfill/global';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/preact';

// In-memory + jq mock so the real Counters container runs in jsdom (single
// browser, no peers). Schedule variety is seeded directly via __setDoc; the
// default-Daily FAB-add path is still exercised live, and the editor's own panes
// are driven in CounterEditor.test.tsx. md-* custom elements are NOT registered
// here, so rows are inert hosts driven by their own handlers.
jest.mock('../../worker-api');
import * as api from '../../worker-api';
import { Counters } from './Counters';

const mock = api as any;

// Guards the positional __mocks__ resolution: if src/client/ui/__mocks__/ ever
// drifts away from worker-api.ts, jest.mock() above silently loads the real
// module and every assertion below fails for an unrelated-looking reason.
it('uses the manual worker-api mock', () => expect(mock.__isMock).toBe(true));
const DOC = 'doc-counters';
const rowOf = (title: string) => screen.getByText(title).closest('[data-status]') as HTMLElement;

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
    expect(rowOf('Stretch').getAttribute('data-status')).toBe('pending');

    // Tapping the row records a completion → moves to "Done". A single-day
    // streak is not a streak yet: the flame badge only renders once the streak
    // reaches 2+ (recurring items show a streak, not a total).
    fireEvent.click(rowOf('Stretch'));
    expect(rowOf('Stretch').getAttribute('data-status')).toBe('done');
    expect(screen.getByRole('heading', { name: 'Done' })).toBeTruthy();
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
    await waitFor(() => expect(screen.getByText('Meditate')).toBeTruthy());
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
    expect(within(rowOf('Meditate')).getByTitle('3-day streak')).toBeTruthy();
  });

  it('deleting a completion rewinds the schedule anchor to the one before it', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    const d = (n: number) => Temporal.Now.plainDateISO().subtract({ days: n }).toString();
    mock.__setDoc(DOC, {
      '@type': 'Calendar+Counters', name: 'C',
      events: {
        e1: {
          '@type': 'Event', title: 'Water plants', created: `${d(9)}T09:00:00Z`, start: d(1),
          recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily', interval: 3 },
          completions: { [`${d(4)}T09:00:00`]: '', [`${d(1)}T09:00:00`]: '' },
        },
      },
    });
    render(<Counters docId={DOC} />);
    await waitFor(() => expect(screen.getByText('Water plants')).toBeTruthy());

    fireEvent.click(within(rowOf('Water plants')).getByTitle('Completions for Water plants'));
    // Newest first, so the first delete button is yesterday's mis-click.
    fireEvent.click(within(screen.getByTestId('completions-sheet')).getAllByTitle('Delete completion')[0]);
    expect(mock.__getDoc(DOC).events.e1.start).toBe(d(4));
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

    // Recording it flips the row to Done, where the recurrence badge returns.
    fireEvent.click(rowOf('Stretch'));
    expect(rowOf('Stretch').getAttribute('data-status')).toBe('done');
    expect(within(rowOf('Stretch')).queryByTestId('counter-due')).toBeNull();
    expect(within(rowOf('Stretch')).getByText('daily')).toBeTruthy();
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

    expect(rowOf('Descale the kettle').getAttribute('data-status')).toBe('pending');
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

  it('non-recurring tallies keep the lifetime N× badge', async () => {
    mock.__setDoc(DOC, {
      '@type': 'Calendar+Counters', name: 'C',
      events: {
        e1: { '@type': 'Event', title: 'Pushups', completions: { '2026-07-19T09:00:00': '', '2026-07-20T09:00:00': '' } },
      },
    });
    render(<Counters docId={DOC} />);
    await waitFor(() => expect(screen.getByText('Pushups')).toBeTruthy());
    expect(within(rowOf('Pushups')).getByText('2×')).toBeTruthy();
  });
});
