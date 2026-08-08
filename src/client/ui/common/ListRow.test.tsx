/**
 * ListRow: the interaction rule, pinned once instead of once per list.
 *
 * The rule is keyed on `actions.length` — 0 means no hold, 1 means the action's own
 * icon and a hold that fires it, 2+ means a kebab and a hold that fires the first.
 * So the cases below are mostly "what does length N produce", plus the two things
 * that have historically broken: the post-hold click-swallow outliving its own
 * gesture, and a press on the trailing control also firing the row.
 *
 * A hold is 450ms of real time, so right-click stands in for it — useLongPress
 * routes both to the same callback. `button: 2` matters: it is a genuine mouse
 * right-click, which produces no follow-up click, so it must NOT arm the swallow.
 * (`md-*` elements never upgrade under jsdom, so the row is an inert host with the
 * handlers attached directly — which is exactly what these assertions read.)
 */
import { render, screen, fireEvent } from '@testing-library/preact';
import { ListRow } from './ListRow';

const row = () => screen.getByTestId('row');

describe('ListRow', () => {
  it('with no actions is inert: no trailing control, no hold, no swallowed menu', () => {
    const onTap = jest.fn();
    render(<ListRow data-testid="row" onTap={onTap}><div slot="headline">A</div></ListRow>);

    expect(row().querySelector('button')).toBeNull();

    // The browser's own context menu must survive a row that has nothing to offer.
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    row().dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);

    fireEvent.keyDown(row(), { key: 'F10', shiftKey: true });
    fireEvent.click(row());
    expect(onTap).toHaveBeenCalledTimes(1); // the click, and nothing the hold did
  });

  it('with no actions and no tap is not even a button', () => {
    render(<ListRow data-testid="row"><div slot="headline">A</div></ListRow>);
    // No `type` → md-list-item renders an inert <li>, not a focusable control
    // that does nothing.
    expect(row().getAttribute('type')).toBeNull();
    expect(row().getAttribute('aria-haspopup')).toBeNull();
  });

  it('with one action shows that action’s icon, and a hold fires it', () => {
    const onSelect = jest.fn();
    const onTap = jest.fn();
    render(
      <ListRow
        data-testid="row" onTap={onTap}
        actions={[{ icon: 'edit', label: 'Edit', title: 'Edit Buy milk', testId: 'act', onSelect }]}
      ><div slot="headline">Buy milk</div></ListRow>,
    );

    // Its own glyph, not a kebab — and the specific title, so a list of rows
    // gives each button a distinguishable accessible name.
    expect(screen.getByTestId('act').textContent).toBe('edit');
    expect(screen.getByRole('button', { name: 'Edit Buy milk' })).toBeTruthy();
    // One destination is not a popup.
    expect(row().getAttribute('aria-haspopup')).toBeNull();

    fireEvent.contextMenu(row(), { button: 2 });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onTap).not.toHaveBeenCalled();

    fireEvent.keyDown(row(), { key: 'F10', shiftKey: true });
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it('with two actions shows a kebab, and a hold fires the first', () => {
    const first = jest.fn();
    const second = jest.fn();
    render(
      <ListRow
        data-testid="row" actionsLabel="Actions for Meditate"
        actions={[
          { icon: 'edit', label: 'Edit', onSelect: first },
          { icon: 'history', label: 'Completions', onSelect: second },
        ]}
      ><div slot="headline">Meditate</div></ListRow>,
    );

    expect(screen.getByRole('button', { name: 'Actions for Meditate' })).toBeTruthy();
    expect(row().getAttribute('aria-haspopup')).toBe('menu');

    fireEvent.contextMenu(row(), { button: 2 });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('does not hold when the first action is disabled', () => {
    const onSelect = jest.fn();
    render(
      <ListRow
        data-testid="row"
        actions={[
          { icon: 'edit', label: 'Rename', onSelect, disabled: true },
          { icon: 'archive', label: 'Archive', onSelect: jest.fn() },
        ]}
      ><div slot="headline">Doc</div></ListRow>,
    );

    // Which action a gesture runs must not depend on permissions — the kebab
    // still reaches the rest.
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    row().dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('leaves the next tap alone after a right-click', () => {
    const onTap = jest.fn();
    const onSelect = jest.fn();
    render(
      <ListRow data-testid="row" onTap={onTap} actions={[{ icon: 'edit', label: 'Edit', onSelect }]}>
        <div slot="headline">A</div>
      </ListRow>,
    );

    // A mouse right-click produces no follow-up click, so arming the swallow
    // there would leave the flag set and eat the user's NEXT genuine tap.
    fireEvent.contextMenu(row(), { button: 2 });
    fireEvent.click(row());
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  describe('as a link', () => {
    const renderLink = (onSelect = jest.fn()) => {
      render(
        <ListRow data-testid="row" href="#/d/abc" actions={[{ icon: 'edit', label: 'Rename', onSelect }]}>
          <div slot="headline">Doc</div>
        </ListRow>,
      );
      return onSelect;
    };

    it('navigates on a plain click and leaves modified clicks to the browser', () => {
      window.location.hash = '#/';
      renderLink();
      expect(row().getAttribute('type')).toBe('link');
      expect(row().getAttribute('href')).toBe('#/d/abc');

      // Each of these means "somewhere else" — a new tab or window. Navigating
      // here too would open the target in both.
      for (const mod of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }]) {
        fireEvent.click(row(), mod);
        expect(window.location.hash).toBe('#/');
      }

      fireEvent.click(row());
      expect(window.location.hash).toBe('#/d/abc');
    });

    it('gives right-click back to the link, keeping the hold and Shift+F10', () => {
      const onSelect = renderLink();

      // Taking the context menu here would cost "Open in new tab" and "Copy
      // link address" to buy a third route to an action two gestures reach.
      const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
      row().dispatchEvent(menu);
      expect(menu.defaultPrevented).toBe(false);
      expect(onSelect).not.toHaveBeenCalled();

      fireEvent.keyDown(row(), { key: 'F10', shiftKey: true });
      expect(onSelect).toHaveBeenCalledTimes(1);
    });
  });

  it('a press on the trailing control fires neither the tap nor the hold', () => {
    const onTap = jest.fn();
    const onSelect = jest.fn();
    render(
      <ListRow
        data-testid="row" onTap={onTap}
        actions={[{ icon: 'edit', label: 'Edit', testId: 'act', onSelect }]}
      ><div slot="headline">A</div></ListRow>,
    );

    // The click bubbles to the row; useLongPress must recognise it as belonging
    // to an interactive child. This is the contract Home's kebab depends on.
    fireEvent.pointerDown(screen.getByTestId('act'), { clientX: 0, clientY: 0 });
    fireEvent.click(screen.getByTestId('act'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onTap).not.toHaveBeenCalled();
  });
});
