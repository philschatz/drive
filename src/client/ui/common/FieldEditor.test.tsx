/**
 * FieldEditor's draft buffering: what Save commits, what Cancel throws away, and
 * the two things that are easy to regress — a stale draft after the parent swaps
 * items, and the blur that has to happen before the commit.
 */
import { render, screen, fireEvent } from '@testing-library/preact';
import { FieldEditor, FieldSheet } from './FieldEditor';

/** The plain-input stand-in for an MdTextField pane, bound the way the panes bind. */
function TextPane({
  value,
  onSave,
  onCancel,
  validate,
}: {
  value: string;
  onSave: (v: string) => void;
  onCancel: () => void;
  validate?: (v: string) => boolean;
}) {
  return (
    <FieldEditor
      data-testid="f"
      value={value}
      onSave={onSave}
      onCancel={onCancel}
      validate={validate}
    >
      {({ value: draft, onInput, save }) => (
        <input
          data-testid="f-input"
          value={draft}
          onInput={(e: any) => onInput(e.currentTarget.value)}
          onKeyDown={(e: any) => { if (e.key === 'Enter') save(); }}
        />
      )}
    </FieldEditor>
  );
}

const type = (v: string) => fireEvent.input(screen.getByTestId('f-input'), { target: { value: v } });

describe('FieldEditor', () => {
  it('seeds the draft from value and commits it on Save', () => {
    const onSave = jest.fn();
    render(<TextPane value="Buy milk" onSave={onSave} onCancel={jest.fn()} />);
    expect((screen.getByTestId('f-input') as HTMLInputElement).value).toBe('Buy milk');

    type('Buy oat milk');
    // Nothing has been committed yet — that is the whole point of the bar.
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('f-save'));
    expect(onSave).toHaveBeenCalledWith('Buy oat milk');
  });

  it('Cancel discards the draft without committing', () => {
    const onSave = jest.fn();
    const onCancel = jest.fn();
    render(<TextPane value="Buy milk" onSave={onSave} onCancel={onCancel} />);

    type('Buy oat milk');
    fireEvent.click(screen.getByTestId('f-cancel'));
    expect(onCancel).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('Enter on the field saves', () => {
    const onSave = jest.fn();
    render(<TextPane value="" onSave={onSave} onCancel={jest.fn()} />);
    type('Walk the dog');
    fireEvent.keyDown(screen.getByTestId('f-input'), { key: 'Enter' });
    expect(onSave).toHaveBeenCalledWith('Walk the dog');
  });

  it('a failing validate disables Save and no-ops Enter', () => {
    const onSave = jest.fn();
    render(<TextPane value="" onSave={onSave} onCancel={jest.fn()} validate={v => !!v.trim()} />);

    expect((screen.getByTestId('f-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByTestId('f-input'), { key: 'Enter' });
    expect(onSave).not.toHaveBeenCalled();

    type('Now valid');
    expect((screen.getByTestId('f-save') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('f-save'));
    expect(onSave).toHaveBeenCalledWith('Now valid');
  });

  it('holds its draft against a changing value, and re-seeds on a key change', () => {
    const onSave = jest.fn();
    const { rerender } = render(
      <TextPane key="t1" value="Buy milk" onSave={onSave} onCancel={jest.fn()} />,
    );
    type('my own words');

    // A peer editing the same field must not yank text out mid-sentence.
    rerender(<TextPane key="t1" value="their words" onSave={onSave} onCancel={jest.fn()} />);
    expect((screen.getByTestId('f-input') as HTMLInputElement).value).toBe('my own words');

    // …but the editor swapping to a different item (Enter-to-add-another) must not
    // carry the old draft into the fresh one.
    rerender(<TextPane key="t2" value="" onSave={onSave} onCancel={jest.fn()} />);
    expect((screen.getByTestId('f-input') as HTMLInputElement).value).toBe('');
  });

  it('blurs the focused control before committing, so presence clears', () => {
    const events: string[] = [];
    render(
      <FieldEditor
        data-testid="f"
        value=""
        onSave={() => events.push('save')}
        onCancel={jest.fn()}
      >
        {({ value, onInput, save }) => (
          <input
            data-testid="f-input"
            value={value}
            onInput={(e: any) => onInput(e.currentTarget.value)}
            onBlur={() => events.push('blur')}
            onKeyDown={(e: any) => { if (e.key === 'Enter') save(); }}
          />
        )}
      </FieldEditor>,
    );

    screen.getByTestId('f-input').focus();
    fireEvent.keyDown(screen.getByTestId('f-input'), { key: 'Enter' });
    // Chrome fires no focusout for an element that is merely unmounted, so the
    // blur has to happen first or the peer's dot sticks on a field nobody is in.
    expect(events).toEqual(['blur', 'save']);
  });
});

describe('FieldSheet', () => {
  it('renders nothing until open, then commits through the same bar', () => {
    const onSave = jest.fn();
    const onClose = jest.fn();
    const sheet = (open: boolean) => (
      <FieldSheet
        open={open}
        title="Rename document"
        value="Notes"
        data-testid="fs"
        fieldTestId="fs-field"
        onSave={onSave}
        onClose={onClose}
      >
        {({ value, onInput }) => (
          <input data-testid="fs-input" value={value} onInput={(e: any) => onInput(e.currentTarget.value)} />
        )}
      </FieldSheet>
    );

    const { rerender } = render(sheet(false));
    expect(screen.queryByTestId('fs')).toBeNull();

    rerender(sheet(true));
    expect(screen.getByText('Rename document')).toBeTruthy();
    fireEvent.input(screen.getByTestId('fs-input'), { target: { value: 'Camping trip' } });
    fireEvent.click(screen.getByTestId('fs-field-save'));
    expect(onSave).toHaveBeenCalledWith('Camping trip');

    // Cancel routes to onClose — the sheet's X and its overlay do the same.
    fireEvent.click(screen.getByTestId('fs-field-cancel'));
    expect(onClose).toHaveBeenCalled();
  });
});
