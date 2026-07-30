/**
 * The single "pick one of these" bottom sheet: a Material list of choices with a
 * checkmark on the current one.
 *
 * This is the app's answer to a long single-select, and the reason it is a sheet
 * rather than a dropdown: MD3's exposed dropdown menu is for a *compact* value that
 * belongs inline with a field (the font-family picker beside a size stepper). A
 * choice that carries an explanation per option — a role and what it permits, a
 * number format and an example of it — is a list, and a list of ten belongs on its
 * own surface instead of pushing the rest of a sheet off-screen.
 *
 * Dismissing without choosing cancels, so callers can treat `onPick` as the only
 * success path. It closes itself *before* `onPick` runs, so anything the handler
 * opens or raises isn't stacked under a sheet that's animating out.
 */

import type { JSX } from 'preact';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';

export interface PickerOption<T extends string> {
  value: T;
  label: string;
  /** Supporting text: what the option means, or an example of it. */
  detail?: string;
  /**
   * Style for the label, when the option should *look* like what it selects — a
   * font name set in that font. The preview is the option, so it beats any wording.
   */
  labelStyle?: JSX.CSSProperties;
  /** material-symbols glyph for the leading slot. */
  icon?: string;
  /**
   * Row testid. `md-list-item` has no implicit ARIA role while unregistered under
   * jsdom, so a row that a test needs to reach must carry one — the value itself is
   * often unusable (a number format is `#,##0.00`).
   */
  testId?: string;
}

export function PickerSheet<T extends string>({
  open,
  title,
  options,
  value,
  onPick,
  onOpenChange,
  'data-testid': testId = 'picker-sheet',
}: {
  open: boolean;
  title: string;
  options: PickerOption<T>[];
  /** The current choice, checked in the list. Omit when there isn't one yet. */
  value?: T;
  onPick: (value: T) => void;
  onOpenChange: (open: boolean) => void;
  'data-testid'?: string;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85vh] p-4 overflow-y-auto">
        {/* SheetContent doesn't forward extra props — testid goes on a wrapper */}
        <div data-testid={testId}>
          <SheetHeader>
            <SheetTitle className="pr-8">{title}</SheetTitle>
          </SheetHeader>

          <md-list style={{ background: 'transparent' }} className="mt-2">
            {options.map(opt => (
              <md-list-item
                key={opt.value}
                type="button"
                data-testid={opt.testId}
                onClick={() => { onOpenChange(false); onPick(opt.value); }}
              >
                {opt.icon && <md-icon slot="start">{opt.icon}</md-icon>}
                <div slot="headline" style={opt.labelStyle}>{opt.label}</div>
                {opt.detail && <div slot="supporting-text" className="font-mono">{opt.detail}</div>}
                {value === opt.value && <md-icon slot="end">check</md-icon>}
              </md-list-item>
            ))}
          </md-list>
        </div>
      </SheetContent>
    </Sheet>
  );
}
