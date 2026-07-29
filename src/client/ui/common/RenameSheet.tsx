/**
 * The single "type a new name" bottom sheet, replacing the `window.prompt`
 * renames scattered through the app (document title, spreadsheet sheet tabs,
 * Home's doc-actions sheet).
 *
 * A native prompt is an OS dialog: it doesn't match the app's Material
 * language, can't be styled, and is invisible to screen recordings. This is the
 * same MdTextField the item editors use, in the same `FieldEditor` their
 * single-field panes use, so renaming a document looks like renaming a task.
 */
import { useRef, useLayoutEffect } from 'preact/hooks';
import { FieldSheet } from './FieldEditor';
import { MdTextField, type MdTextFieldHandle } from '@/components/ui/md-text-field';

export interface RenameSheetProps {
  open: boolean;
  /** Sheet heading, e.g. "Rename document". */
  title?: string;
  /** Field label, e.g. "Name". */
  label?: string;
  /** Starting value; re-read each time the sheet opens. */
  value: string;
  /**
   * Accept an empty name. For stores where blank means *clear* rather than
   * "untitled" — `setFriendName('')` removes the name, which is how you unset your
   * own display name. Documents and sheet tabs keep the non-empty guard.
   */
  allowEmpty?: boolean;
  onRename: (name: string) => void;
  onClose: () => void;
  'data-testid'?: string;
}

export function RenameSheet({
  open,
  title = 'Rename',
  label = 'Name',
  value,
  allowEmpty,
  onRename,
  onClose,
  'data-testid': testId = 'rename-sheet',
}: RenameSheetProps) {
  const fieldRef = useRef<MdTextFieldHandle>(null);

  // useLayoutEffect: iOS only raises the keyboard for a focus() inside the
  // transient user-activation window, which a post-paint effect misses.
  useLayoutEffect(() => { if (open) fieldRef.current?.focus(); }, [open]);

  return (
    <FieldSheet
      open={open}
      title={title}
      value={value}
      data-testid={testId}
      // Fixed stem regardless of which caller opened the sheet, so specs target
      // `rename-save` rather than `doc-rename-sheet-save`.
      fieldTestId="rename"
      // An empty name is a no-op, not an "Untitled": Save disables and Enter does
      // nothing, so the sheet just stays open. Unless `allowEmpty`, where blank is
      // itself the meaningful value (clear the name).
      validate={v => allowEmpty || !!v.trim()}
      onSave={v => { onRename(v.trim()); onClose(); }}
      onClose={onClose}
    >
      {({ value: name, onInput, save }) => (
        <MdTextField
          ref={fieldRef}
          label={label}
          id="rename-input"
          data-testid="rename-input"
          value={name}
          onInput={onInput}
          onEnter={save}
        />
      )}
    </FieldSheet>
  );
}
