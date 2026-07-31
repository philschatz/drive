import 'temporal-polyfill/global';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/preact';

// In-memory + jq mock so the real Counters container runs in jsdom (single
// browser, no peers). The editor's repeat Select is a Radix popover that jsdom
// can't drive, so schedule variety is seeded directly via __setDoc; the
// default-Daily FAB-add path is still exercised live. md-* custom elements are
// NOT registered here, so rows are inert hosts driven by their own handlers.
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

  it('adds a daily habit via the FAB and records a completion via the icon/title buttons', async () => {
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

    // FAB → New Counter sheet; Enter commits (auto-save) and chains to a fresh
    // blank counter; dismiss the sheet with its Close button.
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

    // Clicking the leading icon records a completion → moves to "Done".
    // A single-day streak is not a streak yet: the flame badge only renders
    // once the streak reaches 2+ (recurring items show a streak, not a total).
    fireEvent.click(within(rowOf('Stretch')).getByRole('button', { name: 'Record completion for Stretch' }));
    expect(rowOf('Stretch').getAttribute('data-status')).toBe('done');
    expect(screen.getByRole('heading', { name: 'Done' })).toBeTruthy();
    expect(within(rowOf('Stretch')).queryByTitle('1-day streak')).toBeNull();

    // The title text is a record button too — a second click adds another
    // completion (streak stays 1: same day) without opening the editor.
    fireEvent.click(within(rowOf('Stretch')).getByRole('button', { name: 'Stretch' }));
    expect(screen.queryByText('Edit Counter')).toBeNull();
    const events = mock.__getDoc(DOC).events as Record<string, any>;
    const uid = Object.keys(events).find(k => events[k].title === 'Stretch')!;
    expect(Object.keys(events[uid].completions).length).toBe(2);
    expect(within(rowOf('Stretch')).queryByTitle('1-day streak')).toBeNull();

    // Clicking the row itself (outside icon/title) opens the editor — and must
    // NOT record another completion.
    fireEvent.click(rowOf('Stretch'));
    expect(screen.getByText('Edit Counter')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(Object.keys(mock.__getDoc(DOC).events[uid].completions).length).toBe(2);
  });

  it('archives (via the editor) and unarchives a recurring habit', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    mock.__setDoc(DOC, { '@type': 'Calendar+Counters', name: 'C', events: { e1: dailyHabit('Meditate') } });
    render(<Counters docId={DOC} />);
    await waitFor(() => expect(screen.getByText('Meditate')).toBeTruthy());

    // Archive lives in the editor: open it by clicking the row, then Archive.
    // It's an md-list-item, which carries no implicit role while unregistered
    // under jsdom — address it by testid.
    fireEvent.click(rowOf('Meditate'));
    fireEvent.click(screen.getByTestId('ced-archive'));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('heading', { name: 'Archived' })).toBeTruthy();
    // It's now in the Archived section — no longer a status row in the active list.
    expect(screen.getByText('Meditate').closest('[data-status]')).toBeNull();

    // Unarchive (on the archived row) brings it back to the active list.
    fireEvent.click(screen.getByRole('button', { name: 'Unarchive' }));
    expect(screen.queryByRole('heading', { name: 'Archived' })).toBeNull();
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
