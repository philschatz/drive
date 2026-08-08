/**
 * The two write sheets: editing one value, and adding one property.
 *
 * Both are transactional, which on this screen is not a style choice. The
 * predecessor edited in place with an input that saved on Enter and cancelled on
 * blur — so on a phone, tapping anywhere to dismiss the soft keyboard threw the
 * edit away, and there was no visible Save at all. `FieldEditor`/`GroupEditor`
 * own the draft and offer Cancel/Save, and write once (see common/FieldEditor).
 */
import { FieldSheet, GroupEditor } from '../common/FieldEditor';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { MdTextField } from '@/components/ui/md-text-field';
import type { Path } from './source-nodes';
import './source.css';

/**
 * Edit one value as text.
 *
 * The caller passes the display string and interprets what comes back, because
 * the two callers mean different things by it: a scalar row coerces through
 * `parseValue`, while a rich-text field diffs the flat text into ops. Either way
 * the value arrives here escaped, so `\n` and `￼` are visible and typeable.
 *
 * `readOnly` is the same sheet without the field: tapping a row must still show
 * the whole value on a read-only document, where a row can only ever show the
 * first line of it.
 */
export function ValueSheet({
  open, title, label, value, multiline, readOnly, supportingText, onSave, onClose,
}: {
  open: boolean;
  title: string;
  label: string;
  value: string;
  multiline?: boolean;
  /** No edit affordance — just show the value in full. */
  readOnly?: boolean;
  supportingText?: string;
  onSave: (raw: string) => void;
  onClose: () => void;
}) {
  if (readOnly) {
    if (!open) return null;
    return (
      <Sheet open onOpenChange={(o: boolean) => { if (!o) onClose(); }}>
        <SheetContent side="bottom" className="max-h-[60vh] p-4">
          <div data-testid="value-sheet">
            <SheetHeader>
              <SheetTitle className="pr-8 truncate">{title || label}</SheetTitle>
            </SheetHeader>
            <pre
              className="src-mono src-text mt-4 text-sm rounded-xl bg-surface-container-low p-3 overflow-x-auto"
              data-testid="value-readonly"
            >
              {value}
            </pre>
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <FieldSheet
      open={open}
      title={title}
      value={value}
      onSave={(v) => { onSave(v); onClose(); }}
      onClose={onClose}
      data-testid="value-sheet"
      fieldTestId="value"
    >
      {({ value: draft, onInput, save }) => (
        <MdTextField
          label={label}
          value={draft}
          type={multiline ? 'textarea' : 'text'}
          rows={8}
          supportingText={supportingText}
          data-testid="value-field"
          onInput={onInput}
          // Enter saves a single-line field; a textarea keeps Enter for newlines.
          onEnter={multiline ? undefined : save}
        />
      )}
    </FieldSheet>
  );
}

/**
 * Add a property to a container.
 *
 * A `GroupEditor` rather than two `FieldEditor`s, so the key and the value land
 * in the document together — a half-added property (a key with no value) is not
 * a state worth being able to reach, and it would cost a second undo step.
 * Arrays have no key to name: the index is the current length, shown but not
 * editable.
 */
export function AddPropertySheet({
  open, path, isArray, nextIndex, onAdd, onClose,
}: {
  open: boolean;
  path: Path;
  isArray: boolean;
  nextIndex: number;
  onAdd: (key: string, raw: string) => void;
  onClose: () => void;
}) {
  if (!open) return null;

  const where = path.length ? path.join(' / ') : 'the document root';

  return (
    <Sheet open onOpenChange={(o: boolean) => { if (!o) onClose(); }}>
      <SheetContent side="bottom" className="max-h-[60vh] p-4">
        <div data-testid="add-sheet">
          <SheetHeader>
            <SheetTitle className="pr-8">{isArray ? 'Add item' : 'Add property'}</SheetTitle>
          </SheetHeader>
          <p className="md-body-medium text-on-surface-variant mt-1">
            {isArray ? `Appended to ${where} at index ${nextIndex}.` : `In ${where}.`}
          </p>
          <div className="mt-4">
            <GroupEditor
              value={{ key: isArray ? String(nextIndex) : '', value: '' }}
              // An array's index is fixed; an object needs a key before Save means anything.
              validate={({ key }) => isArray || key.trim().length > 0}
              onSave={({ key, value }) => { onAdd(isArray ? String(nextIndex) : key.trim(), value); onClose(); }}
              onCancel={onClose}
              data-testid="add"
            >
              {({ draft, patch, save }) => (
                <div className="flex flex-col gap-3">
                  {!isArray && (
                    <MdTextField
                      label="Key" value={draft.key} data-testid="add-key"
                      onInput={(v) => patch({ key: v })}
                    />
                  )}
                  <MdTextField
                    label="Value" value={draft.value} data-testid="add-value"
                    supportingText="null, true, false and numbers are stored as themselves"
                    onInput={(v) => patch({ value: v })}
                    onEnter={save}
                  />
                </div>
              )}
            </GroupEditor>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
