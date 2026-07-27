/**
 * The single "type a new name" bottom sheet, replacing the `window.prompt`
 * renames scattered through the app (document title, spreadsheet sheet tabs,
 * Home's doc-actions sheet).
 *
 * A native prompt is an OS dialog: it doesn't match the app's Material
 * language, can't be styled, and is invisible to screen recordings. This is the
 * same MdTextField the item editors use, so renaming a document looks like
 * renaming a task.
 */
import { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'preact/hooks';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { MdTextField, type MdTextFieldHandle } from '@/components/ui/md-text-field';

export interface RenameSheetProps {
  open: boolean;
  /** Sheet heading, e.g. "Rename document". */
  title?: string;
  /** Field label, e.g. "Name". */
  label?: string;
  /** Starting value; re-read each time the sheet opens. */
  value: string;
  onRename: (name: string) => void;
  onClose: () => void;
  'data-testid'?: string;
}

export function RenameSheet({
  open,
  title = 'Rename',
  label = 'Name',
  value,
  onRename,
  onClose,
  'data-testid': testId = 'rename-sheet',
}: RenameSheetProps) {
  const [name, setName] = useState(value);
  const fieldRef = useRef<MdTextFieldHandle>(null);

  // Re-seed on open — the sheet is kept mounted by its parent, so the previous
  // edit would otherwise linger.
  useEffect(() => { if (open) setName(value); }, [open, value]);

  // useLayoutEffect: iOS only raises the keyboard for a focus() inside the
  // transient user-activation window, which a post-paint effect misses.
  useLayoutEffect(() => { if (open) fieldRef.current?.focus(); }, [open]);

  const submit = useCallback((next: string) => {
    const trimmed = next.trim();
    if (!trimmed) return;
    onRename(trimmed);
    onClose();
  }, [onRename, onClose]);

  if (!open) return null;

  return (
    <Sheet open onOpenChange={(o: boolean) => { if (!o) onClose(); }}>
      <SheetContent side="bottom" className="max-h-[60vh] p-4">
        <div data-testid={testId}>
          <SheetHeader>
            <SheetTitle className="pr-8">{title}</SheetTitle>
          </SheetHeader>
          <div className="mt-4">
            <MdTextField
              ref={fieldRef}
              label={label}
              id="rename-input"
              data-testid="rename-input"
              value={name}
              onInput={setName}
              onEnter={submit}
            />
          </div>
          <div className="flex items-center justify-end gap-2 mt-4">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button data-testid="rename-save" onClick={() => submit(name)}>Save</Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
