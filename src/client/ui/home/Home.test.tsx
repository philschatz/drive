/**
 * Home's two worker-driven pushes.
 *
 * The unseen-changes dot rides its OWN channel, separate from the summary query,
 * exactly so it can change when the projection does not (a completed task moves no
 * count but is still a change). The whole state machine behind it is pinned in
 * tests/last-viewed.test.ts; what's pinned here is the last hop — that the row
 * actually renders the dot off that channel, and stops when the flag clears.
 *
 * The "All calendars" gate is here too: it's a count over `entries`, which no
 * amount of worker testing reaches.
 */
import { render, screen, waitFor, fireEvent } from '@testing-library/preact';

jest.mock('../worker-api');

import * as api from '../worker-api';
import { Home } from './Home';

const mock = api as any;

const seed = (docs: Array<{ id: string; type: string; name: string }>) => {
  for (const d of docs) mock.__setDoc(d.id, { '@type': d.type, name: d.name });
  mock.__setDocList(docs.map(d => ({ id: d.id, type: d.type, name: d.name })));
};

/** The doc rows, by headline text, once the list has settled. */
const rows = async (count: number) => {
  await waitFor(() => expect(screen.getAllByTestId('doc-row')).toHaveLength(count));
  return screen.getAllByTestId('doc-row');
};

beforeEach(() => {
  expect(mock.__isMock).toBe(true); // a drifted mock path must fail loudly
  mock.__reset();
  // jsdom has no matchMedia, and Home mounts useInstallNudge, which reads
  // `(display-mode: standalone)` on mount. Report "not installed" — the nudge
  // itself is covered by install-nudge.test.tsx.
  (window as any).matchMedia = jest.fn(() => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

afterEach(() => {
  delete (window as any).matchMedia;
});

describe('the unseen-changes dot', () => {
  it('is absent for a doc with no unseen changes', async () => {
    seed([{ id: 'd1', type: 'TaskList', name: 'Groceries' }]);
    render(<Home />);
    await rows(1);
    expect(screen.queryByTestId('unseen-dot')).toBeNull();
  });

  it('appears on the row the worker flags, and only that row', async () => {
    seed([
      { id: 'd1', type: 'TaskList', name: 'Groceries' },
      { id: 'd2', type: 'TaskList', name: 'Chores' },
    ]);
    render(<Home />);
    const [first, second] = await rows(2);

    mock.__setUnseen({ d2: true });

    await waitFor(() => expect(screen.getAllByTestId('unseen-dot')).toHaveLength(1));
    expect(second.querySelector('[data-testid="unseen-dot"]')).toBeTruthy();
    expect(first.querySelector('[data-testid="unseen-dot"]')).toBeNull();
  });

  it('clears when the doc is marked viewed', async () => {
    seed([{ id: 'd1', type: 'TaskList', name: 'Groceries' }]);
    mock.__setUnseen({ d1: true });
    render(<Home />);
    await rows(1);
    await waitFor(() => expect(screen.getByTestId('unseen-dot')).toBeTruthy());

    mock.__setUnseen({ d1: false });

    await waitFor(() => expect(screen.queryByTestId('unseen-dot')).toBeNull());
  });
});

describe('the "All calendars" menu item', () => {
  // Each md-menu-item renders its icon glyph as text too ("settingsSettings"), so
  // match on the joined text rather than exact labels.
  const menuText = () =>
    Array.from(document.querySelectorAll('md-menu-item')).map(i => i.textContent).join('|');

  it('is hidden with a single calendar — there is nothing to combine', async () => {
    seed([
      { id: 'd1', type: 'Calendar', name: 'Work' },
      { id: 'd2', type: 'TaskList', name: 'Chores' },
    ]);
    render(<Home />);
    await rows(2);
    await waitFor(() => expect(menuText()).toContain('Settings'));
    expect(menuText()).not.toContain('All calendars');
  });

  it('appears once a second calendar-ish doc exists', async () => {
    seed([
      { id: 'd1', type: 'Calendar', name: 'Work' },
      { id: 'd2', type: 'Calendar+Counters', name: 'Habits' },
    ]);
    render(<Home />);
    await rows(2);
    await waitFor(() => expect(menuText()).toContain('All calendars'));
  });

  /**
   * A document row's gestures. The row is a real LINK, which is what makes the
   * rest of this different from every other list in the app: right-click belongs
   * to the browser here (Open in new tab, Copy link address), so the secondary
   * action is reached by a hold or Shift+F10 and NOT by right-click. The kebab's
   * order is a contract rather than presentation, because a hold runs the first
   * item.
   */
  it('is a link, and lists Rename first in the kebab', async () => {
    seed([{ id: 'd1', type: 'Calendar', name: 'Work' }]);
    (api as any).getMyAccess = jest.fn(() => Promise.resolve('admin'));
    render(<Home />);
    const [row] = await rows(1);

    expect(row.getAttribute('type')).toBe('link');
    expect(row.getAttribute('href')).toBe('#/d/d1');

    // Read the headline slot, not the item: md-icon never upgrades under jsdom,
    // so its ligature text ("edit") would otherwise be part of textContent.
    await waitFor(() => expect(row.querySelectorAll('md-menu-item').length).toBe(4));
    expect([...row.querySelectorAll('md-menu-item [slot="headline"]')].map(i => i.textContent?.trim()))
      .toEqual(['Rename', 'Share', 'Archive', 'View source']);

    // Shift+F10 is the keyboard route to the first action; right-click is not a
    // route at all on a link, so the browser's own menu survives.
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
    row.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(false);
    expect(screen.queryByTestId('rename-sheet')).toBeNull();

    fireEvent.keyDown(row, { key: 'F10', shiftKey: true });
    expect(await screen.findByTestId('rename-sheet')).toBeTruthy();
  });

  it('opens the doc on a plain click, and leaves a modified click to the browser', async () => {
    seed([{ id: 'd1', type: 'Calendar', name: 'Work' }]);
    (api as any).getMyAccess = jest.fn(() => Promise.resolve('admin'));
    window.location.hash = '#/';
    render(<Home />);
    const [row] = await rows(1);

    // Cmd/Ctrl+click means "open a new tab" — ours must not also navigate this
    // one, or the doc would open in both.
    fireEvent.click(row, { metaKey: true });
    expect(window.location.hash).toBe('#/');

    fireEvent.click(row);
    expect(window.location.hash).toContain('d1');
  });

  it('ignores a calendar whose access was revoked', async () => {
    seed([
      { id: 'd1', type: 'Calendar', name: 'Work' },
      { id: 'd2', type: 'Calendar', name: 'Gone' },
    ]);
    (api as any).getMyAccess = jest.fn((docId: string) =>
      Promise.resolve(docId === 'd2' ? null : 'admin'));
    render(<Home />);
    await rows(2);
    await waitFor(() => expect(menuText()).toContain('Settings'));
    expect(menuText()).not.toContain('All calendars');
  });
});
