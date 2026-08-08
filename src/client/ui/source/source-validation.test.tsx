/**
 * Validation problems, and the fact that they narrow as you navigate.
 *
 * The panel this replaces listed every error in the document at every level, in an
 * amber Tailwind card whose messages were `title` tooltips — so on a phone the one
 * error you had navigated to was buried among the rest, and none of their messages
 * were readable at all.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/preact';

jest.mock('../worker-api');
import * as api from '../worker-api';
import { SourceViewer } from './SourceViewer';
import { ValidationList } from './ValidationList';
import type { ValidationError } from '../../../shared/schemas';

const mock = api as any;

it('uses the manual worker-api mock', () => expect(mock.__isMock).toBe(true));

const DOC = 'doc-validation';

/** Two bad events, so a level deeper than the root has something to filter to. */
const DATA = {
  '@type': 'Calendar',
  name: 'Work',
  events: {
    'ev-1': { '@type': 'Event', title: 'Standup', duration: 'fifteen' },
    'ev-2': { '@type': 'Event', title: 'Retro', start: 42 },
  },
};

const rowsOf = (el: HTMLElement) =>
  Array.from(el.querySelectorAll('[data-testid="validation-row"]')) as HTMLElement[];
const list = () => screen.getByTestId('validation-list');

beforeEach(() => {
  mock.__reset();
  window.location.hash = `#/source/${DOC}`;
});

describe('ValidationList', () => {
  const errors: ValidationError[] = [
    { path: ['events', 'ev-1', 'duration'], message: 'Expected number, got string' },
    { path: ['events', 'ev-2', 'start'], message: 'Expected string, got number' },
    { path: ['name'], message: 'Unknown key', kind: 'warning' },
  ];

  it('shows everything at the root, since the root contains everything', () => {
    render(<ValidationList errors={errors} path={[]} onNavigate={() => {}} />);
    expect(rowsOf(list())).toHaveLength(3);
    // Nothing is "elsewhere" from the root, so there is nowhere left to go.
    expect(document.querySelector('[data-testid="validation-elsewhere"]')).toBeNull();
  });

  it('narrows to the subtree on screen, and counts what it left out', () => {
    render(<ValidationList errors={errors} path={['events', 'ev-1']} onNavigate={() => {}} />);

    const rows = rowsOf(list());
    expect(rows).toHaveLength(1);
    // Named relative to where you are: 'duration', not the whole path again.
    expect(within(rows[0]).getByText('duration')).toBeTruthy();
    // The message is real text, not a tooltip.
    expect(rows[0].textContent).toContain('Expected number, got string');
    expect(screen.getByTestId('validation-count').textContent).toContain('1 problem');
    expect(screen.getByTestId('validation-elsewhere').textContent).toContain('2 problems elsewhere');
  });

  it('never lists a problem from outside the subtree, only counts it', () => {
    // The list has exactly one meaning and no mode: it is the problems HERE.
    render(<ValidationList errors={errors} path={['events', 'ev-1']} onNavigate={() => {}} />);
    expect(list().textContent).not.toContain('Expected string, got number');
    expect(list().textContent).not.toContain('Unknown key');
  });

  it('stays out of the way where nothing is wrong, but stays reachable', () => {
    const onNavigate = jest.fn();
    render(<ValidationList errors={errors} path={['events', 'ev-3']} onNavigate={onNavigate} />);

    expect(rowsOf(list())).toHaveLength(0);
    // No yellow surface where nothing is wrong — that would cry wolf.
    expect(list().className).not.toContain('src-warn');

    const elsewhere = screen.getByTestId('validation-elsewhere');
    expect(elsewhere.textContent).toContain('3 problems elsewhere');

    // Goes to the root, where the subtree in scope IS the whole document — rather
    // than putting the list into a second mode.
    fireEvent.click(elsewhere);
    expect(onNavigate).toHaveBeenCalledWith([]);
  });

  it('tones a warning differently from a violation', () => {
    render(<ValidationList errors={errors} path={[]} onNavigate={() => {}} />);
    const icons = Array.from(list().querySelectorAll('md-icon[slot="start"]'));
    expect(icons.map(i => i.textContent)).toEqual(['error', 'error', 'warning']);
  });

  it('renders nothing at all when the document is clean', () => {
    render(<ValidationList errors={[]} path={[]} onNavigate={() => {}} />);
    expect(document.querySelector('[data-testid="validation-list"]')).toBeNull();
  });
});

describe('validation in the inspector', () => {
  it('filters as the tree is navigated', async () => {
    mock.__setDoc(DOC, JSON.parse(JSON.stringify(DATA)));
    const view = render(<SourceViewer docId={DOC} />);
    await waitFor(() => expect(screen.getByTestId('validation-list')).toBeTruthy());

    // At the root: everything wrong with the document.
    await waitFor(() => expect(rowsOf(list()).length).toBeGreaterThanOrEqual(3));
    const atRoot = rowsOf(list()).length;

    // One level in: only what is under ev-1. `duration` draws two errors — a type
    // violation and a dependency check — and the filter keeps both.
    view.rerender(<SourceViewer docId={DOC} rest="events/ev-1" />);
    await waitFor(() => expect(rowsOf(list())).toHaveLength(2));
    expect(rowsOf(list()).every(r => r.textContent?.includes('duration'))).toBe(true);
    expect(screen.getByTestId('validation-elsewhere').textContent)
      .toContain(`${atRoot - 2} problem`);
  });

  it('navigates to the problem it names', async () => {
    mock.__setDoc(DOC, JSON.parse(JSON.stringify(DATA)));
    render(<SourceViewer docId={DOC} rest="events/ev-1" />);
    await waitFor(() => expect(rowsOf(list()).length).toBeGreaterThan(0));

    fireEvent.click(rowsOf(list())[0]);
    await waitFor(() => expect(window.location.hash)
      .toBe(`#/source/${DOC}/events/ev-1/duration`));
  });

  it('wears the yellow validation surface, not a data surface', async () => {
    mock.__setDoc(DOC, JSON.parse(JSON.stringify(DATA)));
    render(<SourceViewer docId={DOC} />);
    await waitFor(() => expect(screen.getByTestId('validation-list')).toBeTruthy());
    // One shared class across the problem list, a field's errors and a marker
    // banner — so a problem is recognisable before it is read.
    expect(list().className).toContain('src-warn');
  });
});
