/**
 * The single "are you sure?" bottom sheet, replacing the `window.confirm` calls
 * scattered through Settings (erase all data, opt into synced settings, remove a
 * device).
 *
 * A native confirm is an OS dialog: it doesn't match the app's Material language,
 * can't be styled, and its two buttons say "OK"/"Cancel" no matter what is about
 * to happen. `md-dialog` is not registered (see `md-elements.ts`), and it would be
 * the wrong shape on a phone anyway — so this is a bottom sheet whose answers are
 * the same error-toned `SheetActionItem` rows every option sheet uses. The
 * affirmative row is labelled with the *verb*, so the answer is legible without
 * re-reading the question.
 *
 * The affirmative comes first: it answers the question the title asks, and it is
 * the row the thumb reaches on a phone. Dismissing — the overlay, Escape, the
 * header X, or Cancel — always means "no" and never calls `onConfirm`.
 *
 * Use {@link useConfirm} rather than this component directly at any call site that
 * is already inside an async handler: `if (!await confirm({…})) return;` keeps the
 * control flow the `confirm()` it replaces had.
 */
import { useState, useCallback, useEffect, useRef } from 'preact/hooks';
import type { ComponentChildren, VNode } from 'preact';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { SheetActionItem, SheetActions } from './SheetActionItem';

export interface ConfirmSpec {
  /** The question, as a heading: 'Erase all local data?' */
  title: string;
  /** What happens if they say yes. Prose, so it can carry <strong>. */
  body?: ComponentChildren;
  /** Affirmative row label — a verb, never 'OK': 'Erase everything'. */
  confirmLabel: string;
  /** Affirmative row's leading glyph. Default 'check'. */
  confirmIcon?: string;
  /**
   * Error-tone the affirmative row. For irreversible *loss* — not merely for
   * irreversible: opting into synced settings can't be undone, but tinting
   * "Sync settings" red would read as "this will break something".
   */
  destructive?: boolean;
  /** Default 'Cancel'. */
  cancelLabel?: string;
  /** Testid for the body wrapper; the two rows have fixed testids (see below). */
  'data-testid'?: string;
}

export interface ConfirmSheetProps extends ConfirmSpec {
  open: boolean;
  /** The user said yes. Called after the sheet has closed itself. */
  onConfirm: () => void;
  /** The user said no (Cancel, the X, the overlay, or Escape). */
  onClose: () => void;
}

export function ConfirmSheet({
  open,
  title,
  body,
  confirmLabel,
  confirmIcon = 'check',
  destructive,
  cancelLabel = 'Cancel',
  'data-testid': testId = 'confirm-sheet',
  onConfirm,
  onClose,
}: ConfirmSheetProps) {
  if (!open) return null;

  return (
    <Sheet open onOpenChange={(o: boolean) => { if (!o) onClose(); }}>
      <SheetContent side="bottom" className="max-h-[85vh] p-4 overflow-y-auto">
        {/* SheetContent doesn't forward extra props — testid goes on a wrapper */}
        <div data-testid={testId}>
          <SheetHeader>
            {/* pr-8 clears SheetContent's own X. */}
            <SheetTitle className="pr-8">{title}</SheetTitle>
          </SheetHeader>

          {body && <div className="md-body-medium text-on-surface-variant mt-2">{body}</div>}

          {/* Fixed testids regardless of which call site opened the sheet, on the
              same reasoning as RenameSheet's `rename-save`: the answer rows are
              the same rows whoever asked, so specs shouldn't have to know. */}
          <SheetActions>
            <SheetActionItem
              icon={confirmIcon}
              label={confirmLabel}
              destructive={destructive}
              data-testid="confirm-accept"
              onClick={onConfirm}
            />
            <SheetActionItem icon="close" label={cancelLabel} data-testid="confirm-cancel" onClick={onClose} />
          </SheetActions>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * {@link ConfirmSheet} as a promise, so an async handler reads the way it did
 * with `window.confirm`:
 *
 * ```ts
 * const { confirm, confirmSheet } = useConfirm();
 * …
 * if (!await confirm({ title: 'Erase all data?', confirmLabel: 'Erase everything', destructive: true })) return;
 * await deleteAllData();
 * …
 * return <>{rows}{confirmSheet}</>;
 * ```
 *
 * State is local to the calling component — no App-level portal host, unlike the
 * Toaster — so this adds no global machinery, only one `{confirmSheet}` in JSX.
 */
export function useConfirm(): { confirm: (spec: ConfirmSpec) => Promise<boolean>; confirmSheet: VNode | null } {
  const [spec, setSpec] = useState<ConfirmSpec | null>(null);
  const resolveRef = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback((next: ConfirmSpec) => new Promise<boolean>(resolve => {
    // A second question cancels the first, so no caller is left awaiting forever.
    resolveRef.current?.(false);
    resolveRef.current = resolve;
    setSpec(next);
  }), []);

  const settle = useCallback((ok: boolean) => {
    // Close first, so a snackbar the handler raises isn't under the scrim.
    setSpec(null);
    const resolve = resolveRef.current;
    resolveRef.current = null;
    resolve?.(ok);
  }, []);

  // Unmounting with a question open answers it "no", so an awaiting async handler
  // unwinds instead of leaking its closure for the life of the page.
  useEffect(() => () => {
    resolveRef.current?.(false);
    resolveRef.current = null;
  }, []);

  return {
    confirm,
    confirmSheet: spec
      ? <ConfirmSheet {...spec} open onConfirm={() => settle(true)} onClose={() => settle(false)} />
      : null,
  };
}
