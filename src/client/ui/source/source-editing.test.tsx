/**
 * Writing to the document from the inspector.
 *
 * The point of every spec here is that a write is deliberate and atomic. The
 * predecessor edited in place with an input that saved on Enter and cancelled on
 * blur, so on a phone the gesture that dismisses the keyboard also threw the edit
 * away — and there was no visible Save at all. Deletes went through
 * `window.confirm`.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/preact';

jest.mock('../worker-api');
import * as api from '../worker-api';
import { SourceViewer } from './SourceViewer';

const mock = api as any;

it('uses the manual worker-api mock', () => expect(mock.__isMock).toBe(true));

const DOC = 'doc-edit';
const DATA = {
  '@type': 'Calendar',
  name: 'Work',
  events: { 'ev-1': { title: 'Standup', duration: 15, allDay: false } },
};

const rows = () => Array.from(document.querySelectorAll('[data-testid="source-row"]')) as HTMLElement[];
const rowNamed = (key: string) =>
  rows().find(r => r.getAttribute('data-row-key') === key) as HTMLElement;
const field = () => screen.getByTestId('value-field') as HTMLInputElement;

async function open(rest?: string, data: any = DATA) {
  // A CLONE: the mock stores what it is given by reference and `updateDoc` mutates
  // it in place, so seeding the shared literal would let one spec's write leak into
  // every later one.
  mock.__setDoc(DOC, JSON.parse(JSON.stringify(data)));
  render(<SourceViewer docId={DOC} rest={rest} />);
  await waitFor(() => expect(rows().length).toBeGreaterThan(0));
}

beforeEach(() => {
  mock.__reset();
  window.location.hash = `#/source/${DOC}`;
});

describe('source inspector editing', () => {
  it('edits a value through a sheet with an explicit Save', async () => {
    await open('events/ev-1');

    fireEvent.click(rowNamed('title'));
    await waitFor(() => expect(field()).toBeTruthy());
    expect(field().value).toBe('Standup');

    fireEvent.input(field(), { target: { value: 'Daily standup' } });
    fireEvent.click(screen.getByTestId('value-save'));

    await waitFor(() => expect(mock.__getDoc(DOC).events['ev-1'].title).toBe('Daily standup'));
  });

  it('writes nothing when the edit is cancelled', async () => {
    await open('events/ev-1');

    fireEvent.click(rowNamed('title'));
    await waitFor(() => expect(field()).toBeTruthy());
    fireEvent.input(field(), { target: { value: 'discarded' } });
    fireEvent.click(screen.getByTestId('value-cancel'));

    await waitFor(() => expect(document.querySelector('[data-testid="value-field"]')).toBeNull());
    expect(mock.__getDoc(DOC).events['ev-1'].title).toBe('Standup');
  });

  it('does NOT discard the draft when the field merely loses focus', async () => {
    // The whole reason these panes are transactional: on a phone, tapping away to
    // dismiss the soft keyboard used to be indistinguishable from cancelling.
    await open('events/ev-1');

    fireEvent.click(rowNamed('title'));
    await waitFor(() => expect(field()).toBeTruthy());
    fireEvent.input(field(), { target: { value: 'survives a blur' } });
    fireEvent.blur(field());
    field().dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));

    // Still open, still holding the draft, and nothing written yet.
    expect(field().value).toBe('survives a blur');
    expect(mock.__getDoc(DOC).events['ev-1'].title).toBe('Standup');

    fireEvent.click(screen.getByTestId('value-save'));
    await waitFor(() => expect(mock.__getDoc(DOC).events['ev-1'].title).toBe('survives a blur'));
  });

  it('stores null, booleans and numbers as themselves, not as text', async () => {
    await open('events/ev-1');

    fireEvent.click(rowNamed('duration'));
    await waitFor(() => expect(field()).toBeTruthy());
    fireEvent.input(field(), { target: { value: '30' } });
    fireEvent.click(screen.getByTestId('value-save'));
    await waitFor(() => expect(mock.__getDoc(DOC).events['ev-1'].duration).toBe(30));

    fireEvent.click(rowNamed('allDay'));
    await waitFor(() => expect(field()).toBeTruthy());
    fireEvent.input(field(), { target: { value: 'true' } });
    fireEvent.click(screen.getByTestId('value-save'));
    await waitFor(() => expect(mock.__getDoc(DOC).events['ev-1'].allDay).toBe(true));
  });

  it('asks before deleting, and only deletes if the answer is yes', async () => {
    await open('events/ev-1');

    // The kebab is always visible; long-press reaches the same sheet.
    fireEvent.click(within(rowNamed('duration')).getByTestId('row-kebab'));
    fireEvent.click(await waitFor(() => screen.getByTestId('row-delete')));

    fireEvent.click(await waitFor(() => screen.getByTestId('confirm-cancel')));
    await waitFor(() => expect(document.querySelector('[data-testid="confirm-sheet"]')).toBeNull());
    expect(mock.__getDoc(DOC).events['ev-1'].duration).toBe(15);

    fireEvent.click(within(rowNamed('duration')).getByTestId('row-kebab'));
    fireEvent.click(await waitFor(() => screen.getByTestId('row-delete')));
    fireEvent.click(await waitFor(() => screen.getByTestId('confirm-accept')));

    await waitFor(() => expect('duration' in mock.__getDoc(DOC).events['ev-1']).toBe(false));
    expect(mock.__getDoc(DOC).events['ev-1'].title).toBe('Standup');
  });

  it('reaches the row actions by long-press as well as by the kebab', async () => {
    await open('events/ev-1');

    const row = rowNamed('title');
    fireEvent.pointerDown(row, { clientX: 0, clientY: 0 });
    // useLongPress fires its secondary action after ~450ms of hold.
    await waitFor(() => expect(screen.getByTestId('row-actions')).toBeTruthy(), { timeout: 2000 });
    expect(screen.getByTestId('row-edit')).toBeTruthy();
  });

  it('adds a property with its key and value in one change', async () => {
    await open('events/ev-1');

    fireEvent.click(screen.getByLabelText(/^Add (property|item)$/));
    await waitFor(() => expect(screen.getByTestId('add-sheet')).toBeTruthy());

    fireEvent.input(screen.getByTestId('add-key'), { target: { value: 'location' } });
    fireEvent.input(screen.getByTestId('add-value'), { target: { value: 'Room 3' } });
    fireEvent.click(screen.getByTestId('add-save'));

    await waitFor(() => expect(mock.__getDoc(DOC).events['ev-1'].location).toBe('Room 3'));
  });

  it('will not add a property with no key', async () => {
    await open('events/ev-1');

    fireEvent.click(screen.getByLabelText(/^Add (property|item)$/));
    await waitFor(() => expect(screen.getByTestId('add-value')).toBeTruthy());
    fireEvent.input(screen.getByTestId('add-value'), { target: { value: 'orphan' } });

    expect((screen.getByTestId('add-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('appends to an array at its next index, with no key to type', async () => {
    await open('events/ev-1/tags', {
      '@type': 'Calendar', name: 'Work',
      events: { 'ev-1': { title: 'Standup', tags: ['a', 'b'] } },
    });

    fireEvent.click(screen.getByLabelText(/^Add (property|item)$/));
    await waitFor(() => expect(screen.getByTestId('add-value')).toBeTruthy());
    // An array index is not a name — there is nothing to name it.
    expect(document.querySelector('[data-testid="add-key"]')).toBeNull();

    fireEvent.input(screen.getByTestId('add-value'), { target: { value: 'c' } });
    fireEvent.click(screen.getByTestId('add-save'));

    await waitFor(() => expect(mock.__getDoc(DOC).events['ev-1'].tags).toEqual(['a', 'b', 'c']));
  });

  it('renames the document from the title bar', async () => {
    await open();
    fireEvent.click(screen.getByTitle('Work'));
    const input = await waitFor(() => screen.getByTestId('rename-input') as HTMLInputElement);
    fireEvent.input(input, { target: { value: 'Personal' } });
    fireEvent.click(screen.getByTestId('rename-save'));
    await waitFor(() => expect(mock.__getDoc(DOC).name).toBe('Personal'));
  });
});
