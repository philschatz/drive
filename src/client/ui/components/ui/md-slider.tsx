import { useMemo } from 'preact/hooks';
import { Label } from './label';

/**
 * Material Design 3 slider.
 *
 * Two-mode for the same reason as MdTextField (see its header comment): under
 * jsdom the md-* elements never upgrade, so we fall back to a real
 * `<input type="range">` — which has a `value` setter, so testing-library's
 * `fireEvent.input` can drive it. Same `id` and `data-testid` in both modes.
 *
 * Notes on the md path:
 * - md-slider's `min`/`max` default to 0/100 — always pass them explicitly.
 * - `value` must never be undefined: the element snaps a missing value to the
 *   range midpoint (`this.value ??= this.renderValueEnd`), so the prop is a
 *   required number and the caller owns the seed.
 * - The internal range input's `input` event is composed, and the host's
 *   `.value` is already the new number when it bubbles out. `change` is
 *   host-redispatched on the md path but preact/compat rewrites `onChange` to
 *   an input listener on the fallback input, so only `onInput` is exposed
 *   (same conclusion as md-select.tsx).
 * - The shadow root delegates focus, so `focusin`/`focusout` escape it and the
 *   usual onFocus/onBlur wiring works; `document.activeElement` is the host.
 * - md-slider renders no label text of its own, so both modes share the
 *   Label-above / supporting-text-below shell.
 */

export interface MdSliderProps {
  label: string;
  /** Required — an undefined value would snap the md element to its midpoint. */
  value: number;
  min?: number;
  max?: number;
  step?: number;
  /** Tick marks at each step (md path only). */
  ticks?: boolean;
  /** Value bubble on hover/focus/drag (md path only). */
  labeled?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
  supportingText?: string;
  'data-testid'?: string;
  /** Pass '' to make PropertySheet's pane autofocus pick this control — its
   * fallback selector list doesn't know md-slider. */
  'data-autofocus'?: string;
  onInput?: (value: number, e: Event) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

export function MdSlider({
  label,
  value,
  min,
  max,
  step,
  ticks,
  labeled,
  disabled,
  id,
  className,
  supportingText,
  'data-testid': testId,
  'data-autofocus': autofocus,
  onInput,
  onFocus,
  onBlur,
}: MdSliderProps) {
  const isMd = useMemo(
    () => typeof customElements !== 'undefined' && !!customElements.get('md-slider'),
    [],
  );

  // Host `.value` is already a number on the md path; the fallback's is a string.
  const handleInput = (e: any) => onInput?.(Number(e.currentTarget.value), e);

  const control = isMd ? (
    <md-slider
      id={id}
      data-testid={testId}
      data-autofocus={autofocus}
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={value}
      ticks={ticks || undefined}
      labeled={labeled || undefined}
      disabled={disabled || undefined}
      style={{ width: '100%' }}
      onInput={handleInput}
      onFocus={onFocus}
      onBlur={onBlur}
    />
  ) : (
    <input
      type="range"
      id={id}
      data-testid={testId}
      data-autofocus={autofocus}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      className="w-full"
      onInput={handleInput}
      onFocus={onFocus}
      onBlur={onBlur}
    />
  );

  return (
    <div className={className}>
      <Label htmlFor={id} className="mb-1 block">{label}</Label>
      {control}
      {supportingText && <p className="mt-1 text-sm text-muted-foreground">{supportingText}</p>}
    </div>
  );
}
