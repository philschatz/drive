import { useMemo } from 'preact/hooks';
import { Label } from './label';

/**
 * Material Design 3 outlined select.
 *
 * Same two-mode arrangement as {@link ./md-text-field.tsx MdTextField} — see its
 * header for why. The fallback here is a native `<select>`, which is a coverage
 * win over the Radix `Select` it replaces: that one was a portalled popover
 * jsdom could not open, so editor tests had to seed variety through the document
 * instead of driving the control. `fireEvent.change(select, {target:{value}})`
 * now works.
 *
 * md-path notes:
 * - `value` as a plain JSX prop is correct *because* Preact applies `value` after
 *   `diffChildren`: the setter resolves the value against the element's
 *   `md-select-option` children, which must already exist.
 * - MD dispatches BOTH `input` and `change` on the host for one interaction, so
 *   bind one, not both. It has to be `input`: preact/compat rewrites `onChange`
 *   to an `input` listener on form elements (React semantics), so an `onChange`
 *   prop is unreliable — on the native fallback it silently never fires for a
 *   real `change` event, and on the custom element which one you get depends on
 *   compat's element-name check. `input` fires in every combination, exactly once.
 * - Do NOT commit-on-blur here. The menu lives in the select's shadow root, so
 *   merely opening it fires `focusout` at the host.
 * - Leave `menuPositioning` at its `'popover'` default so the menu renders in the
 *   top layer and escapes the sheet's `overflow-y: auto` clipping.
 * - `display-text` is set explicitly: an option whose headline holds markup (a
 *   colour swatch, say) would otherwise render an empty closed-state label.
 */

export interface MdSelectOption {
  value: string;
  label: string;
  /** Closed-state text, when it differs from `label` (e.g. label holds markup). */
  displayText?: string;
  /** material-symbols name rendered in the option's leading slot. */
  icon?: string;
}

export interface MdSelectProps {
  label: string;
  value: string;
  options: MdSelectOption[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  'data-testid'?: string;
  onFocus?: () => void;
  onBlur?: () => void;
}

export function MdSelect({
  label,
  value,
  options,
  onValueChange,
  disabled,
  id,
  className,
  'data-testid': testId,
  onFocus,
  onBlur,
}: MdSelectProps) {
  const isMd = useMemo(
    () => typeof customElements !== 'undefined' && !!customElements.get('md-outlined-select'),
    [],
  );

  if (isMd) {
    return (
      <md-outlined-select
        id={id}
        data-testid={testId}
        class={className}
        label={label}
        value={value}
        disabled={disabled || undefined}
        style={{ width: '100%' }}
        onInput={(e: any) => onValueChange(e.currentTarget.value)}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        {options.map(o => (
          <md-select-option key={o.value} value={o.value} display-text={o.displayText ?? o.label}>
            {o.icon && <md-icon slot="start">{o.icon}</md-icon>}
            <div slot="headline">{o.label}</div>
          </md-select-option>
        ))}
      </md-outlined-select>
    );
  }

  return (
    <div className={className}>
      <Label htmlFor={id} className="mb-1 block">{label}</Label>
      <select
        id={id}
        data-testid={testId}
        value={value}
        disabled={disabled}
        onInput={(e: any) => onValueChange(e.currentTarget.value)}
        onFocus={onFocus}
        onBlur={onBlur}
        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm"
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}
