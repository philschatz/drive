import { useMemo, useRef, useImperativeHandle } from 'preact/hooks';
import { forwardRef } from 'preact/compat';
import { Input } from './input';
import { Textarea } from './textarea';
import { Label } from './label';

/**
 * Material Design 3 outlined text field.
 *
 * Two-mode by necessity. The `md-*` custom elements are registered only in
 * `main.tsx`, so under jest/jsdom they never upgrade — they are inert unknown
 * elements with no `value` accessor. Testing-library's `fireEvent.input` routes
 * through `setNativeValue`, which requires a `value` *setter* on the element or
 * its prototype and THROWS ("The given element does not have a value setter")
 * without one. So when the element isn't defined we render the plain
 * `Input`/`Textarea` instead, carrying the same `id` and `data-testid` — every
 * handler below reads `(e.currentTarget as any).value`, which is identical in
 * both modes.
 *
 * The mode is computed inside the component rather than at module scope so
 * nothing depends on import order relative to `main.tsx`.
 *
 * Notes on the md path:
 * - `value` goes through as a plain JSX prop. Preact hoists `value` out of the
 *   prop loop and applies it after `diffChildren`, as a property assignment
 *   (`'value' in mdTextField` is true) — so it stays controlled even after the
 *   user types, and never fights the element's own attribute guard.
 * - Dash-cased attributes (`supporting-text`, `error-text`) must be written
 *   dash-cased: `'supportingText' in dom` is false, so camelCase would set a
 *   stray expando instead of reaching Lit.
 * - `input` and `focusout` are both composed, so a host-level listener sees them
 *   from the inner input, and `host.value` is already current when they fire.
 */

export interface MdTextFieldProps {
  label: string;
  value: string;
  type?: 'text' | 'textarea' | 'number' | 'date' | 'time' | 'url';
  rows?: number;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  supportingText?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  'data-testid'?: string;
  onInput?: (value: string, e: Event) => void;
  /** Committed value: fired on focusout, and on Enter unless `onEnter` handles it. */
  onCommit?: (value: string) => void;
  /** Enter on a single-line field. Takes over from `onCommit` when provided. */
  onEnter?: (value: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

export type MdTextFieldHandle = { focus: () => void };

export const MdTextField = forwardRef<MdTextFieldHandle, MdTextFieldProps>(function MdTextField(
  {
    label,
    value,
    type = 'text',
    rows = 3,
    min,
    max,
    step,
    placeholder,
    supportingText,
    disabled,
    id,
    className,
    'data-testid': testId,
    onInput,
    onCommit,
    onEnter,
    onFocus,
    onBlur,
  },
  ref,
) {
  const isMd = useMemo(
    () => typeof customElements !== 'undefined' && !!customElements.get('md-outlined-text-field'),
    [],
  );
  const elRef = useRef<any>(null);
  useImperativeHandle(ref, () => ({ focus: () => elRef.current?.focus() }), []);

  const multiline = type === 'textarea';

  // Non-text fields hold one short token (a count, a date, a time) that is
  // always replaced rather than appended to, so focusing one selects it — you
  // can type straight over it instead of clearing it first. `select()` is safe
  // on the md host and on a number input; `setSelectionRange` is not, and some
  // input types have no text selection at all, hence the guard.
  const selectOnFocus = type === 'number' || type === 'date' || type === 'time';
  const handleFocus = (e: any) => {
    if (selectOnFocus) {
      try { e.currentTarget.select?.(); } catch { /* type has no text selection */ }
    }
    onFocus?.();
  };

  const handleInput = (e: any) => onInput?.(e.currentTarget.value, e);
  // preact/compat aliases onBlur → focusout, which (unlike blur) is composed and
  // so escapes the md element's shadow root.
  const handleBlur = (e: any) => {
    onBlur?.();
    onCommit?.(e.currentTarget.value);
  };
  const handleKeyDown = (e: any) => {
    if (multiline || e.key !== 'Enter') return;
    e.preventDefault();
    if (onEnter) onEnter(e.currentTarget.value);
    else onCommit?.(e.currentTarget.value);
  };

  if (isMd) {
    return (
      <md-outlined-text-field
        ref={elRef}
        id={id}
        data-testid={testId}
        class={className}
        label={label}
        value={value}
        type={multiline ? 'textarea' : type}
        rows={multiline ? rows : undefined}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        // Dash-cased on purpose — see the header comment.
        supporting-text={supportingText}
        disabled={disabled || undefined}
        style={{ width: '100%' }}
        onInput={handleInput}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
      />
    );
  }

  // jsdom / pre-registration fallback: a real input, same id and testid.
  const common = {
    id,
    'data-testid': testId,
    placeholder,
    disabled,
    onInput: handleInput,
    onFocus: handleFocus,
    onBlur: handleBlur,
    onKeyDown: handleKeyDown,
  };
  return (
    <div className={className}>
      <Label htmlFor={id} className="mb-1 block">{label}</Label>
      {multiline ? (
        <Textarea ref={elRef} value={value} rows={rows} {...common} />
      ) : (
        <Input ref={elRef} value={value} type={type} min={min} max={max} step={step} {...common} />
      )}
      {supportingText && <p className="mt-1 text-sm text-muted-foreground">{supportingText}</p>}
    </div>
  );
});
