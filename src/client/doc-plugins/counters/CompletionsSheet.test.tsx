import { render, screen, fireEvent } from '@testing-library/preact';
import dayjs from 'dayjs';

import { CompletionsSheet } from './CompletionsSheet';
import type { CounterEvent } from './schema';

/** A completion key: a timezone-less local-datetime string N units in the past
 * (the format recordClick writes, minus the millisecond suffix). */
const keyAgo = (n: number, unit: dayjs.ManipulateType) =>
  dayjs().subtract(n, unit).format('YYYY-MM-DDTHH:mm:ss');

const baseProps = {
  uid: 'u1',
  open: true,
  onDeleteCompletion: jest.fn(),
  onClose: jest.fn(),
};

const evt = (completions?: CounterEvent['completions']): CounterEvent => ({
  '@type': 'Event',
  title: 'Pushups',
  ...(completions ? { completions } : {}),
});

describe('CompletionsSheet', () => {
  beforeEach(() => jest.clearAllMocks());

  it('lists completions most-recent-first with relative times', () => {
    const kNew = keyAgo(30, 'second');
    const kMid = keyAgo(5, 'minute');
    const kOld = keyAgo(3, 'hour');
    // Insertion order deliberately shuffled — the component must sort, not rely on it.
    render(<CompletionsSheet {...baseProps} event={evt({ [kOld]: '', [kNew]: '', [kMid]: '' })} />);

    expect(screen.getByRole('heading', { name: 'Completions (3)' })).toBeDefined();
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain('few seconds ago');
    expect(items[1].textContent).toContain('5 minutes ago');
    expect(items[2].textContent).toContain('3 hours ago');
    // The absolute timestamp is exposed as a tooltip for precision.
    expect(items[0].querySelector('[title]')?.getAttribute('title')).toBe(kNew);
  });

  it('shows an empty state and a zero count when there are no completions', () => {
    render(<CompletionsSheet {...baseProps} event={evt()} />);
    expect(screen.getByRole('heading', { name: 'Completions (0)' })).toBeDefined();
    expect(screen.getByText('No completions yet.')).toBeDefined();
  });

  it('renders nothing when closed', () => {
    render(<CompletionsSheet {...baseProps} open={false} event={evt()} />);
    expect(screen.queryByTestId('completions-sheet')).toBeNull();
  });

  it('deletes a completion (with confirmation), reporting uid + key', () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    const k = keyAgo(2, 'minute');
    render(<CompletionsSheet {...baseProps} event={evt({ [k]: '' })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete completion' }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(baseProps.onDeleteCompletion).toHaveBeenCalledWith('u1', k);
    confirmSpy.mockRestore();
  });

  it('does not delete when the confirmation is cancelled', () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(false);
    render(<CompletionsSheet {...baseProps} event={evt({ [keyAgo(2, 'minute')]: '' })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete completion' }));
    expect(baseProps.onDeleteCompletion).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('hides delete buttons in read-only (canEdit=false) but still lists completions', () => {
    render(<CompletionsSheet {...baseProps} canEdit={false} event={evt({ [keyAgo(2, 'minute')]: '' })} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Delete completion' })).toBeNull();
  });
});
