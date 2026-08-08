/**
 * The changes sheet: versions, and the operations inside one of them.
 *
 * "See the operations in the version" is half of what this screen is for, and it
 * was previously untestable — the mock's `getDocHistory` and
 * `debugGetVersionPatches` were hard-coded to `[]`. They are seedable now
 * (`__setHistory` / `__setPatches`), so the claims below can actually be checked:
 * picking a version pins it AND shows what it did, and an operation is a way to
 * get to the path it touched.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/preact';

jest.mock('../worker-api');
import * as api from '../worker-api';
import { SourceViewer } from './SourceViewer';
import { formatPatchDetail, formatPatchPath } from './ChangesSheet';

const mock = api as any;

it('uses the manual worker-api mock', () => expect(mock.__isMock).toBe(true));

const DOC = 'doc-changes';
const DATA = {
  '@type': 'Calendar',
  name: 'Work',
  events: { 'ev-1': { title: 'Standup', duration: 15 } },
};

/** Epoch SECONDS — what Automerge change times are. */
const T = 1_770_000_000;
const HISTORY = [
  { version: 0, time: T - 3600 },
  { version: 1, time: T - 600 },
  { version: 2, time: T - 60 },
];

const versionRows = () =>
  Array.from(document.querySelectorAll('[data-testid="version-row"]')) as HTMLElement[];
const opRows = () => Array.from(document.querySelectorAll('[data-testid="op-row"]')) as HTMLElement[];
const currentHash = () => window.location.hash.replace(/^#/, '');

async function open() {
  mock.__setDoc(DOC, JSON.parse(JSON.stringify(DATA)));
  mock.__setHistory(DOC, HISTORY);
  mock.__setPatches(DOC, 1, [
    { action: 'put', path: ['events', 'ev-1', 'title'], value: 'Standup' },
    { action: 'splice', path: ['content', 6], value: 'brave ' },
    { action: 'mark', path: ['content'], marks: [{ name: 'strong', value: true, start: 1, end: 7 }] },
  ]);
  mock.__setPatches(DOC, 2, [{ action: 'del', path: ['events', 'ev-1', 'duration'] }]);
  render(<SourceViewer docId={DOC} />);
  await waitFor(() => expect(document.querySelector('[data-testid="source-level"]')).toBeTruthy());
  // The History button lives on the bar in this view, not behind the kebab.
  fireEvent.click(await waitFor(() => screen.getByTitle('History')));
  await waitFor(() => expect(screen.getByTestId('changes-versions')).toBeTruthy());
}

beforeEach(() => {
  mock.__reset();
  window.location.hash = `#/source/${DOC}`;
});

describe('source inspector changes sheet', () => {
  it('lists every version newest first, marking the latest', async () => {
    await open();

    expect(versionRows().map(r => r.getAttribute('data-version'))).toEqual(['2', '1', '0']);
    // Numbered from 1 for a reader, though the engine counts from 0.
    expect(versionRows()[0].textContent).toContain('3');
    expect(versionRows()[0].textContent).toContain('(latest)');
  });

  it('picking a version pins it and shows what it did', async () => {
    await open();

    fireEvent.click(versionRows()[1]); // version 1, i.e. not the latest
    await waitFor(() => expect(screen.getByTestId('changes-ops')).toBeTruthy());

    // Pinned in the worker, so the document behind the sheet IS that version.
    expect(mock.__getPinnedVersion()).toBe(1);
    expect(screen.getByTestId('changes-ops').textContent).toContain('3 operations');
    expect(opRows().map(r => r.getAttribute('data-action'))).toEqual(['put', 'splice', 'mark']);
  });

  it('spells out what a formatting change did, which a bare value cannot', async () => {
    await open();
    fireEvent.click(versionRows()[1]);
    await waitFor(() => expect(opRows().length).toBe(3));

    const [put, splice, mark] = opRows();
    expect(put.textContent).toContain('events.ev-1.title');
    expect(put.textContent).toContain('"Standup"');
    expect(splice.textContent).toContain('"brave "');
    // A mark carries a name, a value and a range — none of which is a "value".
    expect(mark.textContent).toContain('strong=true [1, 7)');
  });

  it('an operation navigates to the path it touched, and closes the sheet', async () => {
    await open();
    fireEvent.click(versionRows()[1]);
    await waitFor(() => expect(opRows().length).toBe(3));

    fireEvent.click(opRows()[0]);

    await waitFor(() => expect(currentHash()).toBe(`/source/${DOC}/events/ev-1/title`));
    await waitFor(() => expect(document.querySelector('[data-testid="changes-ops"]')).toBeNull());
  });

  it('goes back from the operations to the version list', async () => {
    await open();
    fireEvent.click(versionRows()[1]);
    await waitFor(() => expect(screen.getByTestId('changes-ops')).toBeTruthy());

    fireEvent.click(screen.getByTestId('ops-back'));
    await waitFor(() => expect(screen.getByTestId('changes-versions')).toBeTruthy());
    expect(document.querySelector('[data-testid="changes-ops"]')).toBeNull();
  });

  it('says so rather than showing an empty table when a version has no operations', async () => {
    await open();
    fireEvent.click(versionRows()[2]); // version 0, unseeded
    await waitFor(() => expect(screen.getByText(/No operations recorded/)).toBeTruthy());
  });

  it('asks before restoring, and never uses a native dialog', async () => {
    await open();
    fireEvent.click(versionRows()[1]);
    await waitFor(() => expect(screen.getByTestId('ops-restore')).toBeTruthy());

    fireEvent.click(screen.getByTestId('ops-restore'));
    const sheet = await waitFor(() => screen.getByTestId('confirm-sheet'));
    expect(within(sheet).getByText(/Restore to version 2\?/)).toBeTruthy();
    // The affirmative row is labelled with the verb, not "OK".
    expect(within(sheet).getByTestId('confirm-accept').textContent).toContain('Restore');
  });

  it('warns that a previewed version is not editable, and unpins on close', async () => {
    await open();
    fireEvent.click(versionRows()[1]);
    await waitFor(() => expect(screen.getByTestId('pinned-notice')).toBeTruthy());
    expect(screen.getByTestId('pinned-notice').textContent).toContain('version 2 of 3');

    // Closing History returns to the live latest version rather than leaving the
    // document silently pinned to an old snapshot.
    fireEvent.click(screen.getByTitle('History'));
    await waitFor(() => expect(mock.__getPinnedVersion()).toBeNull());
    expect(document.querySelector('[data-testid="pinned-notice"]')).toBeNull();
  });
});

describe('patch formatting', () => {
  it('names a block-marker insert instead of rendering it as an empty map', () => {
    // Automerge inserts an empty map at a block marker's position, so `{}` is what
    // the generic formatter would say.
    expect(formatPatchDetail({ action: 'insert', path: ['content', 0], values: [{}] }))
      .toBe('¶ block marker');
    // A `put` of a map is an ordinary object (a block's own attrs), not a marker.
    expect(formatPatchDetail({ action: 'put', path: ['content', 0], value: {} })).toBe('{}');
  });

  it('escapes the block-marker character so it does not render as tofu', () => {
    expect(formatPatchDetail({ action: 'splice', value: '￼hi' })).toBe('"\\uFFFChi"');
  });

  it('carries the mark set an inserted run inherited', () => {
    expect(formatPatchDetail({ action: 'insert', values: ['a'], marks: { strong: true } }))
      .toBe('"a" (strong=true)');
  });

  it('formats the other actions', () => {
    expect(formatPatchDetail({ action: 'del', length: 3 })).toBe('×3');
    expect(formatPatchDetail({ action: 'unmark', name: 'em', start: 0, end: 4 })).toBe('em [0, 4)');
    expect(formatPatchDetail({ action: 'inc', value: 2 })).toBe('+2');
    expect(formatPatchDetail({ action: 'inc', value: -2 })).toBe('-2');
  });

  it('names the root rather than showing a blank path', () => {
    expect(formatPatchPath([])).toBe('(root)');
    expect(formatPatchPath(['events', 'ev-1'])).toBe('events.ev-1');
    expect(formatPatchPath(['alerts', 0, 'trigger'])).toBe('alerts.[0].trigger');
  });
});
