import { render, screen, fireEvent, within, waitFor } from '@testing-library/preact';

// Back the worker API with the in-memory + jq mock so the real Tasks container
// runs in jsdom (ported from tests-pw/ui/tasks.spec.ts — single browser, no peers).
jest.mock('../worker-api');
import * as api from '../worker-api';
import { Tasks } from './Tasks';

const mock = api as any;
const DOC = 'doc-tasks';

const seed = () => mock.__setDoc(DOC, { '@type': 'TaskList', name: 'Test Tasks', tasks: {} });
const quickAdd = (title: string, via: 'button' | 'enter' = 'button') => {
  const input = screen.getByPlaceholderText('Add a task...');
  fireEvent.input(input, { target: { value: title } });
  if (via === 'enter') fireEvent.keyDown(input, { key: 'Enter' });
  else fireEvent.click(screen.getByRole('button', { name: 'Add' }));
};
const rowOf = (title: string) => screen.getByText(title).closest('div') as HTMLElement;

describe('Tasks container CRUD', () => {
  beforeEach(() => { mock.__reset(); seed(); });

  it('adds, completes, edits, and bulk-deletes tasks', async () => {
    render(<Tasks docId={DOC} />);
    await waitFor(() => expect(screen.getByPlaceholderText('Add a task...')).toBeTruthy());

    // Quick-add via the Add button, then via Enter.
    quickAdd('Buy milk', 'button');
    expect(screen.getByText('Buy milk')).toBeTruthy();
    quickAdd('Walk the dog', 'enter');
    expect(screen.getByText('Walk the dog')).toBeTruthy();

    // Toggle completion via the checkbox → the title renders struck-through,
    // and the mutation reaches the store.
    fireEvent.click(within(rowOf('Buy milk')).getByRole('checkbox'));
    expect(screen.getByText('Buy milk').style.textDecoration).toBe('line-through');
    const doc = mock.__getDoc(DOC);
    const milkUid = Object.keys(doc.tasks).find((k) => doc.tasks[k].title === 'Buy milk')!;
    expect(doc.tasks[milkUid].progress).toBe('completed');

    // Open the editor by clicking a task title, retitle, and save.
    fireEvent.click(screen.getByText('Walk the dog'));
    expect(screen.getByText('Edit Task')).toBeTruthy();
    fireEvent.input(screen.getByDisplayValue('Walk the dog'), { target: { value: 'Walk the dog in the park' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Walk the dog in the park')).toBeTruthy();

    // Delete Completed removes the finished task, keeps the active one.
    fireEvent.click(screen.getByRole('button', { name: 'Delete Completed' }));
    expect(screen.queryByText('Buy milk')).toBeNull();
    expect(screen.getByText('Walk the dog in the park')).toBeTruthy();
  });

  it('shows the empty state with no tasks', async () => {
    render(<Tasks docId={DOC} />);
    await waitFor(() => expect(screen.getByText('No tasks yet. Add one above.')).toBeTruthy());
  });
});
