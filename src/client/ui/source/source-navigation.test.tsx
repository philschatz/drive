/**
 * Drill-in navigation.
 *
 * The inspector shows one level of the document at a time and the URL says which
 * one, so these specs are really about one claim: `#/source/<id>/<path>` and what
 * is on screen never disagree. That is what makes browser Back walk back up the
 * tree, and what lets a validation error deep-link to a leaf without the panel
 * knowing the document's shape.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/preact';

jest.mock('../worker-api');
import * as api from '../worker-api';
import { SourceViewer } from './SourceViewer';
import { pathFromRest } from './source-nodes';

const mock = api as any;

it('uses the manual worker-api mock', () => expect(mock.__isMock).toBe(true));

const DOC = 'doc-nav';

const DATA = {
  '@type': 'Calendar',
  name: 'Work',
  events: {
    'ev-1': { title: 'Standup', duration: 15 },
    'ev-3': { title: 'Review', alerts: [{ trigger: '-PT5M' }] },
  },
};

/** The route re-renders `SourceViewer` with a new `rest` on every hash change,
 * which is what App.tsx's `/source/:docId/:rest*` does in the real app. */
function renderAt(rest?: string) {
  const view = render(<SourceViewer docId={DOC} rest={rest} />);
  const sync = () => {
    const hash = window.location.hash.replace(/^#/, '');
    const m = /^\/source\/[^/]+\/?(.*)$/.exec(hash);
    view.rerender(<SourceViewer docId={DOC} rest={m?.[1] || undefined} />);
  };
  window.addEventListener('hashchange', sync);
  window.addEventListener('popstate', sync);
  return view;
}

const rows = () => Array.from(document.querySelectorAll('[data-testid="source-row"]')) as HTMLElement[];
const rowNamed = (key: string) =>
  rows().find(r => r.getAttribute('data-row-key') === key) as HTMLElement;
const currentPath = () =>
  pathFromRest(/^\/source\/[^/]+\/?(.*)$/.exec(window.location.hash.replace(/^#/, ''))?.[1] || undefined);

beforeEach(() => {
  mock.__reset();
  window.location.hash = `#/source/${DOC}`;
});

describe('source inspector navigation', () => {
  it('lists the root level, with a chevron only on what navigates', async () => {
    mock.__setDoc(DOC, DATA);
    renderAt();
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));

    expect(rows().map(r => r.getAttribute('data-row-key'))).toEqual(['@type', 'name', 'events']);
    // The container's summary says how much is inside it, so you can tell whether
    // descending is worth a tap.
    expect(rowNamed('events').textContent).toContain('2 keys');
    expect(rowNamed('events').getAttribute('data-kind')).toBe('object');
    expect(rowNamed('name').getAttribute('data-kind')).toBe('string');
  });

  it('descends into a container and puts that level in the URL', async () => {
    mock.__setDoc(DOC, DATA);
    renderAt();
    await waitFor(() => expect(rowNamed('events')).toBeTruthy());

    fireEvent.click(rowNamed('events'));
    await waitFor(() => expect(currentPath()).toEqual(['events']));
    await waitFor(() => expect(rows().map(r => r.getAttribute('data-row-key'))).toEqual(['ev-1', 'ev-3']));

    fireEvent.click(rowNamed('ev-3'));
    await waitFor(() => expect(currentPath()).toEqual(['events', 'ev-3']));
    await waitFor(() => expect(rows().map(r => r.getAttribute('data-row-key'))).toEqual(['title', 'alerts']));
  });

  it('walks into an array by index', async () => {
    mock.__setDoc(DOC, DATA);
    renderAt('events/ev-3/alerts');
    await waitFor(() => expect(rows().length).toBe(1));

    expect(rowNamed('0').getAttribute('data-kind')).toBe('object');
    fireEvent.click(rowNamed('0'));
    await waitFor(() => expect(currentPath()).toEqual(['events', 'ev-3', 'alerts', 0]));
    await waitFor(() => expect(rowNamed('trigger')).toBeTruthy());
  });

  it('goes back up through the breadcrumb, and home from the root chip', async () => {
    mock.__setDoc(DOC, DATA);
    renderAt('events/ev-3');
    await waitFor(() => expect(rowNamed('title')).toBeTruthy());

    const crumbs = () => Array.from(document.querySelectorAll('[data-testid="crumb"]')) as HTMLButtonElement[];
    expect(crumbs().map(c => c.textContent)).toEqual(['events', 'ev-3']);
    // The last crumb is where you already are, so it isn't a way to go anywhere.
    expect(crumbs()[1].disabled).toBe(true);

    fireEvent.click(crumbs()[0]);
    await waitFor(() => expect(currentPath()).toEqual(['events']));

    fireEvent.click(screen.getByTestId('crumb-root'));
    await waitFor(() => expect(currentPath()).toEqual([]));
    await waitFor(() => expect(rowNamed('@type')).toBeTruthy());
  });

  it('lands a deep link to a LEAF on its parent level, pointing at the row', async () => {
    // The shape every other editor's "Edit source" link and the validation panel
    // produce — a path to the field, not to a container.
    mock.__setDoc(DOC, DATA);
    renderAt('events/ev-1/title');
    await waitFor(() => expect(rows().length).toBe(2));

    expect(rows().map(r => r.getAttribute('data-row-key'))).toEqual(['title', 'duration']);
    expect(rowNamed('title').className).toContain('src-revealed');
    expect(rowNamed('duration').className).not.toContain('src-revealed');
    // Pointing at a row must never open anything — a deep link is not a gesture.
    expect(document.querySelector('[data-testid="value-sheet"]')).toBeNull();
  });

  it('falls back to the deepest level that still exists, and says so', async () => {
    mock.__setDoc(DOC, DATA);
    renderAt('events/ev-gone');
    await waitFor(() => expect(screen.getByTestId('missing-notice')).toBeTruthy());

    // Still useful: the level above the thing that vanished.
    expect(rows().map(r => r.getAttribute('data-row-key'))).toEqual(['ev-1', 'ev-3']);
    expect(screen.getByTestId('missing-notice').textContent).toContain('ev-gone');
  });

  it('navigates from a validation error to the path it names', async () => {
    // `@type: 'Calendar'` with no `events`… is valid; a bad `duration` type is not.
    mock.__setDoc(DOC, {
      '@type': 'Calendar', name: 'Work',
      events: { 'ev-1': { '@type': 'Event', title: 'Standup', duration: 'fifteen' } },
    });
    renderAt();
    await waitFor(() => expect(document.querySelector('[data-testid="source-level"]')).toBeTruthy());

    const error = await waitFor(() => {
      const hit = Array.from(document.querySelectorAll('[data-testid="validation-row"]'))
        .find(row => row.textContent?.includes('duration'));
      if (!hit) throw new Error('no validation row for duration yet');
      return hit as HTMLElement;
    });

    fireEvent.click(error);
    // The error names the leaf, so we land on its parent with the row pointed at.
    await waitFor(() => expect(currentPath()).toEqual(['events', 'ev-1', 'duration']));
    await waitFor(() => expect(rowNamed('duration')?.className).toContain('src-revealed'));
  });

  it('offers a filter once a level is too long to scroll through', async () => {
    const cells: Record<string, any> = {};
    for (let i = 0; i < 40; i++) cells[`cell-${i}`] = { value: i };
    mock.__setDoc(DOC, { '@type': 'DataGrid', name: 'Grid', cells });
    renderAt('cells');
    await waitFor(() => expect(rows().length).toBe(40));

    fireEvent.input(screen.getByTestId('level-filter'), { target: { value: 'cell-7' } });
    // cell-7 only — the filter matches the key, not its position in the list.
    await waitFor(() => expect(rows().map(r => r.getAttribute('data-row-key'))).toEqual(['cell-7']));
  });

  it('drops a filter when you navigate away from the level it belongs to', async () => {
    const cells: Record<string, any> = {};
    for (let i = 0; i < 40; i++) cells[`cell-${i}`] = { value: i };
    mock.__setDoc(DOC, { '@type': 'DataGrid', name: 'Grid', cells, other: { a: 1 } });
    renderAt('cells');
    await waitFor(() => expect(rows().length).toBe(40));

    fireEvent.input(screen.getByTestId('level-filter'), { target: { value: 'cell-7' } });
    await waitFor(() => expect(rows()).toHaveLength(1));

    // Up to the root, then back down: the filter belonged to that visit, not to the
    // level — leaving it applied would hide 39 rows with no visible cause.
    fireEvent.click(screen.getByTestId('crumb-root'));
    await waitFor(() => expect(rowNamed('cells')).toBeTruthy());
    fireEvent.click(rowNamed('cells'));
    await waitFor(() => expect(currentPath()).toEqual(['cells']));

    await waitFor(() => expect(rows().length).toBe(40));
    expect((screen.getByTestId('level-filter') as HTMLInputElement).value).toBe('');
  });

  it('shows the whole value of a read-only document without offering to edit it', async () => {
    mock.getMyAccess.mockResolvedValueOnce?.('read');
    mock.__setDoc(DOC, DATA);
    render(<SourceViewer docId={DOC} readOnly />);
    await waitFor(() => expect(rowNamed('name')).toBeTruthy());

    // Nothing here can write: no delete icon, no add button, and — the part a
    // missing-button check never caught — no hold either. The gesture used to
    // fire regardless of `editable` and open a sheet whose Delete silently
    // did nothing. `button: 2` is a genuine mouse right-click, which produces no
    // follow-up click, so it can't eat the tap asserted below.
    expect(document.querySelector('[data-testid="row-delete"]')).toBeNull();
    expect(document.querySelector('md-fab')).toBeNull();
    // Observed as "did useLongPress claim the gesture", not "did a sheet open":
    // handleDelete bails on a read-only doc anyway, so a missing sheet would
    // pass either way. preventDefault is what actually distinguishes a row that
    // has no hold from one that has a hold leading nowhere.
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
    rowNamed('name').dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(false);

    fireEvent.click(rowNamed('name'));
    const sheet = await waitFor(() => screen.getByTestId('value-sheet'));
    expect(within(sheet).getByTestId('value-readonly').textContent).toBe('Work');
    expect(document.querySelector('[data-testid="value-field"]')).toBeNull();
  });
});
