/**
 * ConfirmSheet + useConfirm: the promise bridge that replaced window.confirm.
 *
 * The three cases worth pinning are the ones a native confirm gave for free and a
 * hand-rolled sheet does not: every dismissal path means "no", a second question
 * doesn't leave the first awaiting forever, and unmounting mid-question unwinds the
 * caller instead of leaking its closure.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { useState } from 'preact/hooks';

// Portal-free stubs. Escape lives on the real Sheet's document listener, so the
// dismiss-means-no case is exercised through onOpenChange, which is what Escape,
// the overlay and the header X all route to.
jest.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children, open, onOpenChange }: any) =>
    open
      ? (
        <div data-testid="sheet">
          <button data-testid="sheet-dismiss" onClick={() => onOpenChange(false)} />
          {children}
        </div>
      )
      : null,
  SheetContent: ({ children }: any) => <div>{children}</div>,
  SheetHeader: ({ children }: any) => <div>{children}</div>,
  SheetTitle: ({ children }: any) => <div>{children}</div>,
}));

import { ConfirmSheet, useConfirm, type ConfirmSpec } from './ConfirmSheet';

const SPEC: ConfirmSpec = {
  title: 'Erase all local data?',
  body: 'Documents not shared with another device are lost forever.',
  confirmLabel: 'Erase everything',
  confirmIcon: 'delete_forever',
  destructive: true,
  'data-testid': 'confirm-delete-all',
};

/** A host that records every answer the promise resolves with. */
function Host({ answers }: { answers: boolean[] }) {
  const { confirm, confirmSheet } = useConfirm();
  return (
    <>
      <button data-testid="ask" onClick={() => confirm(SPEC).then(ok => answers.push(ok))} />
      <button data-testid="ask-again" onClick={() => confirm({ ...SPEC, title: 'Second?' }).then(ok => answers.push(ok))} />
      {confirmSheet}
    </>
  );
}

/**
 * Wraps Host so it can be genuinely unmounted — the cleanup that answers an
 * outstanding question lives in useConfirm, so an early `return` inside Host
 * (which keeps the hook mounted) would not exercise it.
 */
function Unmountable({ answers }: { answers: boolean[] }) {
  const [gone, setGone] = useState(false);
  return (
    <>
      <button data-testid="unmount" onClick={() => setGone(true)} />
      {!gone && <Host answers={answers} />}
    </>
  );
}

describe('ConfirmSheet', () => {
  it('renders the question, its consequences, and a verb for the answer', () => {
    render(<ConfirmSheet {...SPEC} open onConfirm={() => {}} onClose={() => {}} />);
    const body = screen.getByTestId('confirm-delete-all');
    expect(body.textContent).toContain('Erase all local data?');
    expect(body.textContent).toContain('lost forever');
    expect(body.textContent).toContain('Erase everything');
    expect(body.textContent).toContain('Cancel');
  });

  it('error-tones both the icon and the headline of a destructive answer', () => {
    render(<ConfirmSheet {...SPEC} open onConfirm={() => {}} onClose={() => {}} />);
    const accept = screen.getByTestId('confirm-accept');
    const tinted = [...accept.children].filter(el =>
      (el as HTMLElement).style.color === 'var(--md-sys-color-error)');
    // The glyph AND the label — a tinted icon beside plain text doesn't read as destructive.
    expect(tinted).toHaveLength(2);
  });

  it('leaves a non-destructive answer untinted', () => {
    render(
      <ConfirmSheet
        title="Sync settings?" confirmLabel="Sync settings" open
        onConfirm={() => {}} onClose={() => {}}
      />,
    );
    const accept = screen.getByTestId('confirm-accept');
    expect([...accept.children].some(el => (el as HTMLElement).style.color)).toBe(false);
  });

  it('renders nothing when closed', () => {
    render(<ConfirmSheet {...SPEC} open={false} onConfirm={() => {}} onClose={() => {}} />);
    expect(screen.queryByTestId('confirm-delete-all')).toBeNull();
  });
});

describe('useConfirm', () => {
  it('resolves true from the affirmative row', async () => {
    const answers: boolean[] = [];
    render(<Host answers={answers} />);
    fireEvent.click(screen.getByTestId('ask'));
    fireEvent.click(await screen.findByTestId('confirm-accept'));
    await waitFor(() => expect(answers).toEqual([true]));
    // And it closes itself, so a snackbar the handler raises isn't under the scrim.
    expect(screen.queryByTestId('confirm-delete-all')).toBeNull();
  });

  it('resolves false from Cancel', async () => {
    const answers: boolean[] = [];
    render(<Host answers={answers} />);
    fireEvent.click(screen.getByTestId('ask'));
    fireEvent.click(await screen.findByTestId('confirm-cancel'));
    await waitFor(() => expect(answers).toEqual([false]));
  });

  it('resolves false when dismissed (overlay / Escape / the header X)', async () => {
    const answers: boolean[] = [];
    render(<Host answers={answers} />);
    fireEvent.click(screen.getByTestId('ask'));
    fireEvent.click(await screen.findByTestId('sheet-dismiss'));
    await waitFor(() => expect(answers).toEqual([false]));
  });

  it('cancels an outstanding question when a second one is asked', async () => {
    const answers: boolean[] = [];
    render(<Host answers={answers} />);
    fireEvent.click(screen.getByTestId('ask'));
    await screen.findByTestId('confirm-delete-all');

    fireEvent.click(screen.getByTestId('ask-again'));
    // The first resolved false rather than hanging forever.
    await waitFor(() => expect(answers).toEqual([false]));
    expect(screen.getByTestId('confirm-delete-all').textContent).toContain('Second?');

    fireEvent.click(screen.getByTestId('confirm-accept'));
    await waitFor(() => expect(answers).toEqual([false, true]));
  });

  it('answers "no" when the host unmounts mid-question', async () => {
    const answers: boolean[] = [];
    render(<Unmountable answers={answers} />);
    fireEvent.click(screen.getByTestId('ask'));
    await screen.findByTestId('confirm-delete-all');

    fireEvent.click(screen.getByTestId('unmount'));
    // Otherwise the awaiting async handler never unwinds.
    await waitFor(() => expect(answers).toEqual([false]));
  });
});
