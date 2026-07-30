/**
 * ResizeSheet: the row-height / column-width picker.
 *
 * The two things pinned here both shipped broken and both hid the same way — the
 * sheet reported a change the grid could not show. A bad field read used to fall
 * through `parseInt(v) || 0` to the clamp floor, and the "Applies to …" line read
 * "1 row" for an empty selection, so nothing downstream (a test included) could
 * tell an empty resize from a real one.
 *
 * Sheet is stubbed portal-free, as ConfirmSheet.test.tsx does. MdTextField needs no
 * stub: `md-outlined-text-field` never upgrades under jsdom, so it falls back to a
 * real <input> carrying the same testid (see components/ui/md-text-field.tsx).
 */
import { render, screen, fireEvent } from '@testing-library/preact';

jest.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children, open }: any) => (open ? <div data-testid="sheet">{children}</div> : null),
  SheetContent: ({ children }: any) => <div>{children}</div>,
  SheetHeader: ({ children }: any) => <div>{children}</div>,
  SheetTitle: ({ children }: any) => <div>{children}</div>,
}));

import { ResizeSheet } from './ResizeSheet';
import { SIZE_LIMITS, DEFAULT_ROW_HEIGHT } from './sheet-actions';

const setup = (props: Partial<Parameters<typeof ResizeSheet>[0]> = {}) => {
  const applied: (number | null)[] = [];
  render(
    <ResizeSheet
      open
      onOpenChange={() => {}}
      kind="row"
      count={1}
      currentSize={null}
      onApply={s => applied.push(s)}
      {...props}
    />
  );
  return {
    applied,
    field: () => screen.getByTestId('resize-input') as HTMLInputElement,
    button: (name: string) => screen.getByLabelText(name) as HTMLButtonElement,
  };
};

describe('ResizeSheet', () => {
  it('seeds the field from the stored size', () => {
    expect(setup({ currentSize: 64 }).field().value).toBe('64');
  });

  it('seeds the field from the default when nothing is stored', () => {
    expect(setup().field().value).toBe(String(DEFAULT_ROW_HEIGHT));
  });

  it('commits the typed value', () => {
    const { applied, field } = setup();
    fireEvent.input(field(), { target: { value: '60' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(applied).toEqual([60]);
  });

  it('clamps a commit to the axis limits', () => {
    const { applied, field } = setup();
    fireEvent.input(field(), { target: { value: '9999' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(applied).toEqual([SIZE_LIMITS.row.max]);
  });

  // The regression: an unparseable read (an empty field mid-edit, or a host whose
  // shadow value hasn't synced) became 0 and was clamped up to the minimum, so the
  // grid silently got the smallest row instead of what was typed.
  it('ignores an unparseable value instead of applying the minimum', () => {
    const { applied, field, button } = setup({ currentSize: 64 });
    fireEvent.input(field(), { target: { value: '' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(applied).toEqual([]);
    // …and the size it was holding is intact: the next step moves from 64, not
    // from 0 or from the floor.
    fireEvent.click(button('Increase row height'));
    expect(applied).toEqual([64 + SIZE_LIMITS.row.step]);
  });

  it('steps by the axis step, and stops at the floor', () => {
    const { applied, button } = setup({ currentSize: SIZE_LIMITS.row.min + SIZE_LIMITS.row.step });
    fireEvent.click(button('Decrease row height'));
    expect(applied).toEqual([SIZE_LIMITS.row.min]);
    expect(button('Decrease row height').disabled).toBe(true);
  });

  it('Reset clears the stored size', () => {
    const { applied } = setup({ currentSize: 80 });
    fireEvent.click(screen.getByText('Reset'));
    expect(applied).toEqual([null]);
  });

  describe('the "applies to" line counts the real selection', () => {
    it.each([
      [1, 'row', 'Applies to 1 row.'],
      [3, 'row', 'Applies to 3 rows.'],
      [1, 'col', 'Applies to 1 column.'],
      [2, 'col', 'Applies to 2 columns.'],
      // The bug: `count > 1 ? … : '1 row'` claimed one row for a selection of none.
      [0, 'row', 'Applies to 0 rows.'],
    ] as const)('count %i of %ss reads "%s"', (count, kind, text) => {
      setup({ count, kind });
      expect(screen.getByText(text)).toBeTruthy();
    });
  });
});
