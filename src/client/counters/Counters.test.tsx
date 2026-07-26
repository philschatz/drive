import 'temporal-polyfill/global';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/preact';

// In-memory + jq mock so the real Counters container runs in jsdom (single
// browser, no peers). The editor's repeat Select is a Radix popover that jsdom
// can't drive, so schedule variety is seeded directly via __setDoc; the
// default-Daily FAB-add path is still exercised live. md-* custom elements are
// NOT registered here, so rows are inert hosts driven by their own handlers.
jest.mock('../worker-api');
import * as api from '../worker-api';
import { Counters } from './Counters';

const mock = api as any;
const DOC = 'doc-counters';
const rowOf = (title: string) => screen.getByText(title).closest('[data-status]') as HTMLElement;

const dailyHabit = (title: string, start = '2026-07-01') => ({
  '@type': 'Event', title, start,
  recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily' },
});

describe('Counters container', () => {
  beforeEach(() => { mock.__reset(); });

  it('adds a daily habit via the FAB and records a completion by tapping it', async () => {
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

    // Tapping the row records a completion → moves to "Done" with a 1× badge.
    fireEvent.click(rowOf('Stretch'));
    expect(rowOf('Stretch').getAttribute('data-status')).toBe('done');
    expect(screen.getByRole('heading', { name: 'Done' })).toBeTruthy();
    expect(within(rowOf('Stretch')).getByText('1×')).toBeTruthy();

    // The trailing kebab opens the editor — it must NOT record another
    // completion (the kebab stops propagation; the hook ignores control clicks).
    fireEvent.click(within(rowOf('Stretch')).getByRole('button', { name: 'Edit Stretch' }));
    expect(screen.getByText('Edit Counter')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(within(rowOf('Stretch')).getByText('1×')).toBeTruthy();
  });

  it('archives (via the editor) and unarchives a recurring habit', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    mock.__setDoc(DOC, { '@type': 'Calendar+Counters', name: 'C', events: { e1: dailyHabit('Meditate') } });
    render(<Counters docId={DOC} />);
    await waitFor(() => expect(screen.getByText('Meditate')).toBeTruthy());

    // Archive now lives in the editor: open via the kebab, then Archive.
    fireEvent.click(within(rowOf('Meditate')).getByRole('button', { name: 'Edit Meditate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('heading', { name: 'Archived' })).toBeTruthy();
    // It's now in the Archived section — no longer a status row in the active list.
    expect(screen.getByText('Meditate').closest('[data-status]')).toBeNull();

    // Unarchive (on the archived row) brings it back to the active list.
    fireEvent.click(screen.getByRole('button', { name: 'Unarchive' }));
    expect(screen.queryByRole('heading', { name: 'Archived' })).toBeNull();
    confirmSpy.mockRestore();
  });

  it('opens the editor via the row kebab', async () => {
    mock.__setDoc(DOC, { '@type': 'Calendar+Counters', name: 'C', events: { e1: dailyHabit('Meditate') } });
    render(<Counters docId={DOC} />);
    await waitFor(() => expect(screen.getByText('Meditate')).toBeTruthy());

    fireEvent.click(within(rowOf('Meditate')).getByRole('button', { name: 'Edit Meditate' }));
    expect(screen.getByText('Edit Counter')).toBeTruthy();
  });
});
