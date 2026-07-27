/**
 * PropertySheet's list↔detail state machine and its presence dots.
 *
 * md-* elements are unregistered under jsdom, so md-list-item is an inert host
 * whose children render in light DOM — rows are addressed by testid rather than
 * text, since a row's textContent concatenates icon + label + summary.
 */
import { render, screen, fireEvent } from '@testing-library/preact';
import { PropertySheet } from './PropertySheet';
import type { PropertyDef } from './PropertySheet';

jest.mock('../worker-api', () => ({
  usePeerTransports: () => ({}),
  getWorkerPeerId: () => 'me-drive',
  getWorkerUserGroupId: () => 'me',
}));

const PROPS: PropertyDef[] = [
  {
    id: 'p-title',
    label: 'Title',
    icon: 'edit',
    summary: () => 'Buy milk',
    render: () => <input data-autofocus data-testid="p-title-input" />,
  },
  {
    id: 'p-when',
    label: 'When',
    icon: 'schedule',
    summary: () => '',
    presenceIds: ['p-date', 'p-time'],
    render: () => <input data-testid="p-when-input" />,
  },
];

const peer = { color: '#f00', peerId: 'alice-drive', userGroupId: 'alice' };

function setup(overrides: Partial<Parameters<typeof PropertySheet>[0]> = {}) {
  const onClose = jest.fn();
  render(
    <PropertySheet open title="Edit Task" properties={PROPS} onClose={onClose} data-testid="ps" {...overrides} />,
  );
  return { onClose };
}

describe('PropertySheet', () => {
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

  it('renders a peer dot on the focused row only', () => {
    setup({ peerFocusedFields: { 'p-title': peer } });
    const dots = screen.getAllByTestId('peer-dot');
    expect(dots).toHaveLength(1);
    expect(screen.getByTestId('p-title-row').contains(dots[0])).toBe(true);
  });

  it('the detail pane repeats the dot by the field title and greys the field', () => {
    setup({ peerFocusedFields: { 'p-title': peer }, initialDetailId: 'p-title' });
    // Field title + dot above the control…
    expect(screen.getByText('Title')).toBeTruthy();
    expect(screen.getByTestId('peer-dot').title).toMatch(/is editing/);
    // …and the control itself greyed but NOT disabled.
    const input = screen.getByTestId('p-title-input') as HTMLInputElement;
    expect((input.parentElement as HTMLElement).style.opacity).toBe('0.5');
    expect(input.disabled).toBe(false);
  });

  it('greys the list row a peer occupies without blocking it', () => {
    setup({ peerFocusedFields: { 'p-title': peer } });
    const row = screen.getByTestId('p-title-row');
    expect(row.style.opacity).toBe('0.5');
    expect(screen.getByTestId('p-when-row').style.opacity).toBe('');
    // Still navigable.
    fireEvent.click(row);
    expect(screen.getByTestId('p-title-input')).toBeTruthy();
  });

  it('a grouped row lights up for any of its presenceIds', () => {
    setup({ peerFocusedFields: { 'p-time': peer } });
    const dot = screen.getByTestId('peer-dot');
    expect(screen.getByTestId('p-when-row').contains(dot)).toBe(true);
  });

  it('flushOnClose blurs the focused field so commit-on-blur runs', () => {
    const onCommit = jest.fn();
    const props: PropertyDef[] = [
      {
        id: 'p-x',
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
