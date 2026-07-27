import { render, screen, fireEvent, waitFor } from '@testing-library/preact';

// Back the worker API with the in-memory + jq mock so the real Tasks container
// runs in jsdom (single browser, no peers). The md-* custom elements are NOT
// registered here (registration lives in main.tsx), so they render inert —
// interactions go through the row's own handlers, which is what we're testing.
jest.mock('../../worker-api');
import * as api from '../../worker-api';
import { Tasks } from './Tasks';

const mock = api as any;

// Guards the positional __mocks__ resolution: if src/client/ui/__mocks__/ ever
// drifts away from worker-api.ts, jest.mock() above silently loads the real
// module and every assertion below fails for an unrelated-looking reason.
it('uses the manual worker-api mock', () => expect(mock.__isMock).toBe(true));
const DOC = 'doc-tasks';

const seed = () => mock.__setDoc(DOC, { '@type': 'TaskList', name: 'Test Tasks', tasks: {} });

/** Add a task through the FAB → New Task sheet (auto-save: Enter commits and
 *  chains to the next blank task; there is no Save button). */
const addTask = (title: string) => {
  fireEvent.click(document.querySelector('md-fab')!);
  expect(screen.getByText('New Task')).toBeTruthy();
  const input = screen.getByTestId('ted-title');
  fireEvent.input(input, { target: { value: title } });
  fireEvent.keyDown(input, { key: 'Enter' });
};

/** Dismiss the editor sheet (the only "done" gesture under auto-save). */
const closeSheet = () => fireEvent.click(screen.getByRole('button', { name: 'Close' }));

/** A task row is the md-list-item carrying role="checkbox". */
const rowOf = (title: string) =>
  screen.getByText(title).closest('md-list-item') as HTMLElement;

describe('Tasks container CRUD', () => {
  beforeEach(() => { mock.__reset(); seed(); });

  it('adds, completes, edits, and bulk-deletes tasks', async () => {
    render(<Tasks docId={DOC} />);
    await waitFor(() => expect(document.querySelector('md-fab')).toBeTruthy());

    // Add two tasks via the FAB sheet (Enter commits + chains).
    addTask('Buy milk');
    expect(screen.getByText('Buy milk')).toBeTruthy();
    addTask('Walk the dog');
    expect(screen.getByText('Walk the dog')).toBeTruthy();
    // Enter = rapid entry: the sheet stays open on a fresh blank task…
    expect(screen.getByText('New Task')).toBeTruthy();
    expect((screen.getByTestId('ted-title') as HTMLInputElement).value).toBe('');
    // …and Enter on an empty title is a no-op (no accidental "Untitled").
    fireEvent.keyDown(screen.getByTestId('ted-title'), { key: 'Enter' });
    expect(Object.values(mock.__getDoc(DOC).tasks).length).toBe(2);
    closeSheet();

    // Tap the row to toggle completion → the title renders struck-through,
    // and the mutation reaches the store.
    fireEvent.click(rowOf('Buy milk'));
    expect(screen.getByText('Buy milk').style.textDecoration).toBe('line-through');
    const doc = mock.__getDoc(DOC);
    const milkUid = Object.keys(doc.tasks).find((k) => doc.tasks[k].title === 'Buy milk')!;
    expect(doc.tasks[milkUid].progress).toBe('completed');
    expect(rowOf('Buy milk').getAttribute('data-checked')).toBe('true');

    // Open the editor via the row's trailing kebab, retitle — auto-save
    // commits on blur, no Save button. An existing task opens on the property
    // list (only a NEW one jumps straight into the title), so tap Title first.
    fireEvent.click(screen.getByRole('button', { name: 'Edit Walk the dog' }));
    expect(screen.getByText('Edit Task')).toBeTruthy();
    fireEvent.click(screen.getByTestId('ted-title-row'));
    const titleInput = screen.getByTestId('ted-title');
    expect((titleInput as HTMLInputElement).value).toBe('Walk the dog');
    fireEvent.input(titleInput, { target: { value: 'Walk the dog in the park' } });
    // preact/compat (loaded via Radix) aliases onBlur to a focusout listener;
    // real browsers fire focusout alongside blur, but in jsdom we must dispatch
    // the native event ourselves (fireEvent.blur/focusOut miss it).
    fireEvent(titleInput, new FocusEvent('focusout', { bubbles: true }));
    // Auto-save wrote through on blur (before the sheet is even dismissed).
    expect(
      Object.values(mock.__getDoc(DOC).tasks).map((t: any) => t.title)
    ).toContain('Walk the dog in the park');
    closeSheet();
    expect(screen.getByText('Walk the dog in the park')).toBeTruthy();

    // "Delete completed" (a title-bar action) is guarded by a confirmation:
    // declining leaves everything alone …
    expect(screen.getByTitle('Delete completed')).toBeTruthy();
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByTitle('Delete completed'));
    expect(confirmSpy).toHaveBeenCalled();
    expect(screen.getByText('Buy milk')).toBeTruthy();

    // … accepting removes the finished task and keeps the active one.
    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByTitle('Delete completed'));
    expect(screen.queryByText('Buy milk')).toBeNull();
    expect(screen.getByText('Walk the dog in the park')).toBeTruthy();
    // Nothing completed left, so the action is no longer offered.
    expect(screen.queryByTitle('Delete completed')).toBeNull();
    confirmSpy.mockRestore();
  });

  it('shows the empty state with no tasks', async () => {
    render(<Tasks docId={DOC} />);
    await waitFor(() => expect(screen.getByText('No tasks yet.')).toBeTruthy());
  });
});
