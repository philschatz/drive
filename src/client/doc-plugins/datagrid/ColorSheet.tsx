import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { PRESET_COLORS } from './format-presets';

export type ColorTarget = 'text' | 'fill';

/**
 * Swatch grid + custom colour input (port of the old toolbar's
 * ColorPickerContent, Radix-free). Exported so it can be embedded elsewhere.
 */
export function ColorGrid({
  value,
  onChange,
  onReset,
  resetLabel,
}: {
  value?: string;
  onChange: (color: string) => void;
  onReset: () => void;
  resetLabel: string;
}) {
  return (
    <div>
      <button
        className="w-full text-left md-body-medium px-2 py-2 mb-2 rounded state-layer flex items-center gap-2"
        onClick={onReset}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 20 }}>format_color_reset</span>
        {resetLabel}
      </button>
      <div className="grid grid-cols-10 gap-1 mb-2">
        {PRESET_COLORS.map(color => (
          <button
            key={color}
            aria-label={color}
            className={
              'aspect-square w-full rounded-sm border border-outline-variant cursor-pointer' +
              (value === color ? ' ring-2 ring-primary ring-offset-1' : '')
            }
            style={{ background: color }}
            title={color}
            onClick={() => onChange(color)}
          />
        ))}
      </div>
      <div className="flex items-center gap-2 mt-1 pt-2 border-t border-outline-variant">
        <span className="md-body-medium text-on-surface-variant">Custom:</span>
        <input
          type="color"
          value={value || '#000000'}
          onChange={(e) => onChange((e.target as HTMLInputElement).value)}
          className="w-9 h-9 cursor-pointer border-0 p-0 bg-transparent"
        />
      </div>
    </div>
  );
}

/**
 * Colour-only bottom sheet, opened from the bottom bar's text/fill colour
 * buttons and from the formatting sheet. Stays open while colours are applied
 * so shades can be compared; dismissing is the "done" gesture.
 */
export function ColorSheet({
  target,
  onOpenChange,
  textColor,
  bgColor,
  onApply,
}: {
  /** Which colour is being edited; null closes the sheet. */
  target: ColorTarget | null;
  onOpenChange: (open: boolean) => void;
  textColor?: string;
  bgColor?: string;
  onApply: (target: ColorTarget, color: string | undefined) => void;
}) {
  const isFill = target === 'fill';
  return (
    <Sheet open={target !== null} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[70vh] p-4">
        {/* SheetContent doesn't forward extra props — testid goes on a wrapper */}
        <div data-testid="color-sheet">
          <SheetHeader>
            <SheetTitle>{isFill ? 'Fill color' : 'Text color'}</SheetTitle>
          </SheetHeader>
          <div className="mt-2">
            <ColorGrid
              value={isFill ? bgColor : textColor}
              onChange={(c) => onApply(isFill ? 'fill' : 'text', c)}
              onReset={() => onApply(isFill ? 'fill' : 'text', undefined)}
              resetLabel={isFill ? 'No fill' : 'Default'}
            />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
