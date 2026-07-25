import { render, screen, fireEvent } from '@testing-library/preact';
import dayjs from 'dayjs';
import { CounterEditor } from './CounterEditor';
import type { CounterEvent } from './schema';

/** A completion key: a timezone-less local-datetime string N units in the past
 * (the format recordClick writes, minus the millisecond suffix). */
const keyAgo = (n: number, unit: dayjs.ManipulateType) =>
  dayjs().subtract(n, unit).format('YYYY-MM-DDTHH:mm:ss');

const baseProps = {
  uid: 'u1',
  isNew: false,
  opened: true,
  onSave: jest.fn(),
  onDelete: jest.fn(),
  onDeleteCompletion: jest.fn(),
  onClose: jest.fn(),
};

const evt = (completions?: CounterEvent['completions']): CounterEvent => ({
  '@type': 'Event',
  title: 'Pushups',
  ...(completions ? { completions } : {}),
});

describe('CounterEditor completions log', () => {
  beforeEach(() => jest.clearAllMocks());

  it('lists completions most-recent-first with relative times', () => {
    const kNew = keyAgo(30, 'second');
    const kMid = keyAgo(5, 'minute');
    const kOld = keyAgo(3, 'hour');
    // Insertion order deliberately shuffled — the component must sort, not rely on it.
    render(<CounterEditor {...baseProps} event={evt({ [kOld]: '', [kNew]: '', [kMid]: '' })} />);

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
    render(<CounterEditor {...baseProps} event={evt()} />);
    expect(screen.getByRole('heading', { name: 'Completions (0)' })).toBeDefined();
    expect(screen.getByText('No completions yet.')).toBeDefined();
  });

  it('omits the completions section entirely for a brand-new counter', () => {
    render(<CounterEditor {...baseProps} isNew event={{ '@type': 'Event', title: '' }} />);
    expect(screen.queryByText(/^Completions/)).toBeNull();
  });

  it('deletes a completion (with confirmation), reporting uid + key', () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    const k = keyAgo(2, 'minute');
    render(<CounterEditor {...baseProps} event={evt({ [k]: '' })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete completion' }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(baseProps.onDeleteCompletion).toHaveBeenCalledWith('u1', k);
    confirmSpy.mockRestore();
  });

  it('does not delete when the confirmation is cancelled', () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(false);
    render(<CounterEditor {...baseProps} event={evt({ [keyAgo(2, 'minute')]: '' })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete completion' }));
    expect(baseProps.onDeleteCompletion).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('hides delete buttons in read-only (canEdit=false) but still lists completions', () => {
    render(<CounterEditor {...baseProps} canEdit={false} event={evt({ [keyAgo(2, 'minute')]: '' })} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Delete completion' })).toBeNull();
  });
});
