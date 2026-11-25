/**
 * PropertySheet's list↔detail state machine and its presence dots.
 *
 * md-* elements are unregistered under jsdom, so md-list-item is an inert host
 * whose children render in light DOM — rows are addressed by testid rather than
 * text, since a row's textContent concatenates icon + label + summary.
 */
import { render, screen, fireEvent, act } from '@testing-library/preact';
import { PropertySheet } from './PropertySheet';
import type { PropertyDef } from './PropertySheet';
import * as workerApi from '../worker-api';

// The shared in-memory mock: it records what presence this client announces and
// lets a test put peers on the document.
jest.mock('../worker-api');
const mock = workerApi as any;

const PROPS: PropertyDef[] = [
  {
    id: 'p-title',
    prop: 'title',
    label: 'Title',
    icon: 'edit',
    summary: () => 'Buy milk',
    render: () => <input data-autofocus data-testid="p-title-input" />,
  },
  {
    id: 'p-when',
    prop: ['start', 'duration'],
    label: 'When',
    icon: 'schedule',
    summary: () => '',
    render: () => <input data-testid="p-when-input" />,
  },
];

function setup(overrides: Partial<Parameters<typeof PropertySheet>[0]> = {}) {
  const onClose = jest.fn();
  render(
    <PropertySheet open title="Edit Task" properties={PROPS} presence={null} onClose={onClose} data-testid="ps" {...overrides} />,
  );
  return { onClose };
}

describe('PropertySheet', () => {
  beforeEach(() => {
    expect(mock.__isMock).toBe(true);
    mock.__reset();
  });

  it('opens in list mode and shows each property with its value', () => {
    setup();
    expect(screen.getByTestId('ps')).toBeTruthy();
    expect(screen.getByTestId('p-title-row').textContent).toContain('Buy milk');
    // Empty values get an "Add <label>" placeholder.
    expect(screen.getByTestId('p-when-row').textContent).toContain('Add when');
  });

  it('tapping a row enters detail mode and back returns to the list', () => {
    setup();
    fireEvent.click(screen.getByTestId('p-title-row'));
    expect(screen.getByTestId('p-title-input')).toBeTruthy();
    expect(screen.queryByTestId('p-when-row')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByTestId('p-when-row')).toBeTruthy();
    expect(screen.queryByTestId('p-title-input')).toBeNull();
  });

  it('a transactional pane drops the Back arrow, since it has its own Cancel', () => {
    setup({
      properties: [{ ...PROPS[0], transactional: true }, PROPS[1]],
    });
    fireEvent.click(screen.getByTestId('p-title-row'));
    expect(screen.getByTestId('p-title-input')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();

    // Escape still pops to the list, which is what that pane's Cancel does too.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByTestId('p-when-row')).toBeTruthy();
  });

  it('focuses the [data-autofocus] control on entering detail', () => {
    setup();
    fireEvent.click(screen.getByTestId('p-title-row'));
    expect(document.activeElement).toBe(screen.getByTestId('p-title-input'));
  });

  it('initialDetailId opens straight into a property', () => {
    setup({ initialDetailId: 'p-title' });
    expect(screen.getByTestId('p-title-input')).toBeTruthy();
  });

  it('Escape in detail pops back to the list without closing', () => {
    const { onClose } = setup({ initialDetailId: 'p-title' });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('p-title-row')).toBeTruthy();
  });

  it('Escape in list mode closes the sheet', () => {
    const { onClose } = setup();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('an already-handled Escape (an open md-menu) does not close the sheet', () => {
    const { onClose } = setup();
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    e.preventDefault();
    document.dispatchEvent(e);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('flushOnClose blurs the focused field so commit-on-blur runs', () => {
    const onCommit = jest.fn();
    const props: PropertyDef[] = [
      {
        id: 'p-x',
        prop: null,
        label: 'X',
        icon: 'edit',
        summary: () => '',
        render: () => <input data-autofocus data-testid="x" onBlur={onCommit} />,
      },
    ];
    render(
      <PropertySheet
        open
        title="T"
        properties={props}
        presence={null}
        initialDetailId="p-x"
        flushOnClose
        onClose={jest.fn()}
      />,
    );
    expect(document.activeElement).toBe(screen.getByTestId('x'));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onCommit).toHaveBeenCalled();
  });
});

/**
 * Presence is the sheet's own job: given where the item lives and which document
 * property each row edits, it announces what this user has open and shows where
 * peers are. No editor wires a focus handler for it.
 */
describe('PropertySheet presence', () => {
  const DOC = 'doc-1';
  const ITEM = ['events', 'e1'];

  const DEFS: PropertyDef[] = [
    {
      id: 'p-title', label: 'Title', icon: 'edit', summary: () => 'Lunch', prop: 'title',
      render: () => <input data-autofocus data-testid="p-title-input" />,
    },
    {
      // Several controls, two document properties, one row.
      id: 'p-when', label: 'When', icon: 'schedule', summary: () => '', prop: ['start', 'duration'], grouped: true,
      render: () => (<><input data-testid="p-date-input" /><input data-testid="p-length-input" /></>),
    },
    {
      id: 'p-move', label: 'Calendar', icon: 'folder', summary: () => 'Home', prop: null,
      render: () => <input data-testid="p-move-input" />,
    },
  ];

  const sheet = (path: (string | number)[] = ITEM, open = true) => (
    <PropertySheet open={open} title="Edit" properties={DEFS} presence={{ docId: DOC, path }} onClose={() => {}} data-testid="ps" />
  );
  const focused = () => mock.__presenceSent(DOC)?.focusedField;
  const peerOn = (...path: (string | number)[]) =>
    act(() => mock.__setPresence(DOC, {
      'alice-drive': { peerId: 'alice-drive', value: { viewing: true, focusedField: path, userGroupId: 'alice' } },
    }));

  beforeEach(() => {
    expect(mock.__isMock).toBe(true);
    mock.__reset();
  });

  it('announces the item while the list shows', () => {
    render(sheet());
    expect(mock.__presenceSent(DOC)).toEqual({ viewing: true, focusedField: ITEM });
  });

  it('announces the property while its pane is open, and the item again on Back', () => {
    render(sheet());
    fireEvent.click(screen.getByTestId('p-title-row'));
    expect(focused()).toEqual([...ITEM, 'title']);
    fireEvent.click(screen.getByLabelText('Back'));
    expect(focused()).toEqual(ITEM);
  });

  // The point of announcing at pane level: a control nobody attached a focus
  // handler to is covered, and moving between a pane's controls changes nothing.
  it('stays on the property whichever of the pane\'s controls has focus', () => {
    render(sheet());
    fireEvent.click(screen.getByTestId('p-when-row'));
    expect(focused()).toEqual([...ITEM, 'start']);
    const before = mock.__presenceCalls(DOC).length;
    fireEvent.focusIn(screen.getByTestId('p-length-input'));
    fireEvent.focusOut(screen.getByTestId('p-length-input'));
    expect(mock.__presenceCalls(DOC)).toHaveLength(before);
    expect(focused()).toEqual([...ITEM, 'start']);
  });

  it('a pane that edits no property of the item announces the item', () => {
    render(sheet());
    fireEvent.click(screen.getByTestId('p-move-row'));
    expect(focused()).toEqual(ITEM);
  });

  it('follows the item when the editor swaps it with the pane open', () => {
    const { rerender } = render(sheet());
    fireEvent.click(screen.getByTestId('p-title-row'));
    const before = mock.__presenceCalls(DOC).length;
    rerender(sheet(['events', 'e2']));
    // Replaced in one step: no null in between for peers to flicker on.
    expect(mock.__presenceCalls(DOC).slice(before)).toEqual([{ focusedField: ['events', 'e2', 'title'] }]);
  });

  it('withdraws it when the sheet closes', () => {
    const { rerender } = render(sheet());
    fireEvent.click(screen.getByTestId('p-title-row'));
    rerender(sheet(ITEM, false));
    expect(focused()).toBeNull();
  });

  it('announces nothing without a presence', () => {
    render(<PropertySheet open title="Edit" properties={DEFS} presence={null} onClose={() => {}} data-testid="ps" />);
    expect(mock.__presenceSent(DOC)).toBeUndefined();
  });

  it('puts a dot on the row whose property a peer has open', () => {
    render(sheet());
    peerOn(...ITEM, 'title');
    const dots = screen.getAllByTestId('peer-dot');
    expect(dots).toHaveLength(1);
    expect(screen.getByTestId('p-title-row').contains(dots[0])).toBe(true);
    expect(screen.getByTestId('p-title-row').style.opacity).toBe('0.5');
    expect(screen.getByTestId('p-when-row').style.opacity).toBe('');
  });

  it('lights a row for any of the properties it covers', () => {
    render(sheet());
    peerOn(...ITEM, 'duration');
    expect(screen.getByTestId('p-when-row').contains(screen.getByTestId('peer-dot'))).toBe(true);
  });

  it('ignores a peer in another item, or on the item but in no property', () => {
    render(sheet());
    peerOn('events', 'e2', 'title');
    expect(screen.queryByTestId('peer-dot')).toBeNull();
    peerOn(...ITEM);
    expect(screen.queryByTestId('peer-dot')).toBeNull();
  });

  it('the detail pane repeats the dot by the field title and greys the field', () => {
    render(sheet());
    fireEvent.click(screen.getByTestId('p-title-row'));
    peerOn(...ITEM, 'title');
    expect(screen.getByTestId('peer-dot').title).toMatch(/is editing/);
    const input = screen.getByTestId('p-title-input') as HTMLInputElement;
    expect((input.parentElement as HTMLElement).style.opacity).toBe('0.5');
    expect(input.disabled).toBe(false);
  });

  it('a grouped pane names its cluster even with no peer in it', () => {
    render(sheet());
    fireEvent.click(screen.getByTestId('p-when-row'));
    expect(screen.getByTestId('ps-detail').textContent).toContain('When');
    expect(screen.queryByTestId('peer-dot')).toBeNull();
  });
});

