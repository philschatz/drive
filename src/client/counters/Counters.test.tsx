import 'temporal-polyfill/global';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/preact';

// In-memory + jq mock so the real Counters container runs in jsdom (ported from
// tests-pw/ui/counters.spec.ts — single browser, no peers). The quick-add repeat
// Select is a Radix popover that jsdom can't drive, so schedule variety is seeded
// directly via __setDoc; the default-Daily quick-add path is still exercised live.
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

  it('quick-adds a daily habit and records a completion by clicking it', async () => {
    mock.__setDoc(DOC, { '@type': 'Calendar+Counters', name: 'Test Counters', events: {} });
    render(<Counters docId={DOC} />);
    await waitFor(() => expect(screen.getByPlaceholderText('Add a todo/counter...')).toBeTruthy());

    // The met/missed chart renders even when empty.
    expect(document.querySelector('svg[aria-label="Met vs missed occurrences per week"]')).toBeTruthy();

    // Quick-add with the default "Daily" cadence → a habit due today ("To do").
    fireEvent.input(screen.getByPlaceholderText('Add a todo/counter...'), { target: { value: 'Stretch' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('heading', { name: 'To do' })).toBeTruthy();
    expect(rowOf('Stretch').getAttribute('data-status')).toBe('pending');

    // Clicking the icon+title records a completion → moves to "Done" with a 1× badge.
    fireEvent.click(screen.getByText('Stretch'));
    expect(rowOf('Stretch').getAttribute('data-status')).toBe('done');
    expect(screen.getByRole('heading', { name: 'Done' })).toBeTruthy();
    expect(within(rowOf('Stretch')).getByText('1×')).toBeTruthy();

    // Clicking the rest of the row (the count badge) opens the editor — it must
    // NOT record another completion (stopPropagation boundary around icon+title).
    fireEvent.click(within(rowOf('Stretch')).getByText('1×'));
    expect(screen.getByText('Edit Counter')).toBeTruthy();
    expect(within(rowOf('Stretch')).getByText('1×')).toBeTruthy();
  });

  it('archives and unarchives a recurring habit', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    mock.__setDoc(DOC, { '@type': 'Calendar+Counters', name: 'C', events: { e1: dailyHabit('Meditate') } });
    render(<Counters docId={DOC} />);
    await waitFor(() => expect(screen.getByText('Meditate')).toBeTruthy());

    // Archive ends the recurrence: the habit leaves the active list for "Archived".
    fireEvent.click(within(rowOf('Meditate')).getByRole('button', { name: 'Archive' }));
    expect(screen.getByRole('heading', { name: 'Archived' })).toBeTruthy();
    // It's now in the Archived section — no longer a status row in the active list.
    expect(screen.getByText('Meditate').closest('[data-status]')).toBeNull();

    // Unarchive brings it back to the active list.
    fireEvent.click(screen.getByRole('button', { name: 'Unarchive' }));
    expect(screen.queryByRole('heading', { name: 'Archived' })).toBeNull();
    confirmSpy.mockRestore();
  });

  it('opens the editor via the pencil button', async () => {
    mock.__setDoc(DOC, { '@type': 'Calendar+Counters', name: 'C', events: { e1: dailyHabit('Meditate') } });
    render(<Counters docId={DOC} />);
    await waitFor(() => expect(screen.getByText('Meditate')).toBeTruthy());

    fireEvent.click(within(rowOf('Meditate')).getByRole('button', { name: 'Edit counter' }));
    expect(screen.getByText('Edit Counter')).toBeTruthy();
  });
});
