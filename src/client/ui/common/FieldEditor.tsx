/**
 * The transactional editor for a *single* field: the control, then a Cancel/Save
 * row beneath it.
 *
 * Everywhere else in the app a field auto-saves — it commits on `focusout`, and
 * the sheet blurs the focused element on close so nothing is lost. That is
 * invisible: typing into a field and tapping Back looks like a cancel but is a
 * save, and there is no way to abandon an edit. So a pane that edits one field
 * owns its draft here and only pushes it outward on Save.
 *
 * Multi-control panes (a calendar event's When, a recurrence rule) keep
 * auto-saving — there is no single value to buffer — and so do dropdowns, where
 * picking from a menu is already the deliberate gesture a Save button would add.
 *
 * Used two ways: inside a {@link PropertySheet} detail pane (which drops its Back
 * arrow for these, so Cancel is the one way out), and via {@link FieldSheet} as a
 * standalone bottom-sheet modal (RenameSheet).
 */
import { useState, useCallback } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';

export interface FieldRenderCtx {
  /** The draft. Bind to the control's `value`. */
  value: string;
  /** Bind to the control's `onInput`. */
  onInput: (v: string) => void;
  /** Commit the draft. Bind to `onEnter` on a single-line field. */
  save: () => void;
}

export interface FieldEditorProps {
  /**
   * Committed value; seeds the draft on mount and *deliberately never re-seeds*.
   * That is what transactional means — a peer editing the same field concurrently
   * does not yank text out from under you mid-sentence. The presence dot beside
   * the field title is the warning. Pass `key` to force a fresh draft (e.g. the
   * task editor swapping to a new item without closing the pane).
   */
  value: string;
  /** Commit the draft. Also responsible for leaving the pane, if it should. */
  onSave: (value: string) => void;
  /** Discard — inside a PropertySheet this is the render ctx's `back`. */
  onCancel: () => void;
  /** Reject a draft (an empty new-task title): Save disables and `save()` no-ops. */
  validate?: (value: string) => boolean;
  children: (ctx: FieldRenderCtx) => ComponentChildren;
  /** Stem for the buttons' testids: `${testId}-save` / `${testId}-cancel`. */
  'data-testid'?: string;
}

export function FieldEditor({
  value,
  onSave,
  onCancel,
  validate,
  children,
  'data-testid': testId,
}: FieldEditorProps) {
  const [draft, setDraft] = useState(value);
  const valid = validate ? validate(draft) : true;

  const save = useCallback(() => {
    if (validate && !validate(draft)) return;
    // Blur before committing, for the mirror of the reason PropertySheet's
    // `flushOnClose` blurs before closing: Chrome fires no `focusout` when a
    // focused element is simply unmounted, so the control's onBlur — which clears
    // this peer's presence — would never run and the dot would stick on a field
    // nobody is in. These fields carry no `onCommit`, so the blur writes nothing.
    (document.activeElement as HTMLElement | null)?.blur?.();
    onSave(draft);
  }, [draft, onSave, validate]);

  return (
    <>
      {children({ value: draft, onInput: setDraft, save })}
      <div className="flex items-center justify-end gap-2 mt-4">
        <Button
          variant="outline"
          data-testid={testId ? `${testId}-cancel` : undefined}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          disabled={!valid}
          data-testid={testId ? `${testId}-save` : undefined}
          onClick={save}
        >
          Save
        </Button>
      </div>
    </>
  );
}

export interface FieldSheetProps extends Omit<FieldEditorProps, 'onCancel' | 'data-testid'> {
  open: boolean;
  /** Sheet heading, e.g. "Rename document". */
  title: string;
  /** Dismiss — the overlay, Escape, the header X, and Cancel all route here. */
  onClose: () => void;
  /** Testid for the body wrapper. Callers name their own instance of the sheet. */
  'data-testid'?: string;
  /**
   * Stem for the Cancel/Save testids, separate from the wrapper's: the buttons are
   * the same buttons whichever instance of the sheet is open, so specs shouldn't
   * have to know which caller opened it.
   */
  fieldTestId?: string;
}

/**
 * {@link FieldEditor} as a standalone bottom sheet, for one-field edits that
 * aren't part of a property list. The top-right X comes from `SheetContent`, so
 * `pr-8` on the title keeps the heading clear of it.
 */
export function FieldSheet({
  open,
  title,
  onClose,
  'data-testid': testId,
  fieldTestId,
  ...editor
}: FieldSheetProps) {
  // Double-gated with <Sheet open> so the body remounts on each open — which is
  // what re-seeds the draft from `value` and re-runs the field's autofocus.
  if (!open) return null;

  return (
    <Sheet open onOpenChange={(o: boolean) => { if (!o) onClose(); }}>
      <SheetContent side="bottom" className="max-h-[60vh] p-4">
        <div data-testid={testId}>
          <SheetHeader>
            <SheetTitle className="pr-8">{title}</SheetTitle>
          </SheetHeader>
          <div className="mt-4">
            <FieldEditor {...editor} onCancel={onClose} data-testid={fieldTestId} />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
