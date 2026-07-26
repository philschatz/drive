import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select';
import { FONT_FAMILIES, FONT_SIZES, NUMBER_FORMATS, PRESET_COLORS } from './format-presets';
import type { DataGridCellFormat } from './schema';

/**
 * Swatch grid + custom color input (port of the old toolbar's
 * ColorPickerContent, Radix-free).
 */
function ColorGrid({
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
        className="w-full text-left md-body-medium px-2 py-1 mb-2 rounded state-layer flex items-center gap-1"
        onClick={onReset}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>format_color_reset</span>
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
      <div className="flex items-center gap-2 mt-1 pt-1 border-t border-outline-variant">
        <span className="md-body-medium text-on-surface-variant">Custom:</span>
        <input
          type="color"
          value={value || '#000000'}
          onChange={(e) => onChange((e.target as HTMLInputElement).value)}
          className="w-8 h-8 cursor-pointer border-0 p-0"
        />
      </div>
    </div>
  );
}

function ToggleButton({
  icon,
  label,
  checked,
  onClick,
}: {
  icon: string;
  label: string;
  checked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      className={
        'inline-flex items-center justify-center h-10 w-10 rounded-full state-layer' +
        (checked ? ' bg-secondary-container text-on-secondary-container' : '')
      }
    >
      <span className="material-symbols-outlined" style={{ fontSize: 22 }}>{icon}</span>
    </button>
  );
}

function SectionLabel({ children }: { children: string }) {
  return <div className="md-label-large text-on-surface-variant mt-4 mb-1">{children}</div>;
}

/**
 * Text-formatting bottom sheet (focus mode): font, size, styles, colors,
 * alignment, number formats, conditional formatting, clear. Applies each
 * change to the current selection immediately and stays open — formatting is
 * iterative; dismissing the sheet is the "done" gesture.
 */
export function FormatSheet({
  open,
  onOpenChange,
  currentFormat,
  onApply,
  onClear,
  onOpenConditional,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resolved format of the primary selected cell (toggle/checked state). */
  currentFormat: DataGridCellFormat | undefined;
  /** Apply a patch to the selection (undefined values delete keys). */
  onApply: (patch: Partial<DataGridCellFormat>) => void;
  onClear: () => void;
  onOpenConditional: () => void;
}) {
  const fontSize = currentFormat?.fontSize ?? 11;
  const smaller = FONT_SIZES.filter(s => s < fontSize);
  const larger = FONT_SIZES.filter(s => s > fontSize);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85vh] p-4">
        <SheetHeader>
          <SheetTitle>Text formatting</SheetTitle>
        </SheetHeader>
        {/* SheetContent doesn't forward extra props — testid goes on a wrapper */}
        <div data-testid="format-sheet">

        {/* Style toggles + alignment */}
        <div className="flex items-center gap-1 mt-2 flex-wrap">
          <ToggleButton icon="format_bold" label="Bold" checked={!!currentFormat?.bold}
            onClick={() => onApply({ bold: !currentFormat?.bold || undefined })} />
          <ToggleButton icon="format_italic" label="Italic" checked={!!currentFormat?.italic}
            onClick={() => onApply({ italic: !currentFormat?.italic || undefined })} />
          <ToggleButton icon="format_underlined" label="Underline" checked={!!currentFormat?.underline}
            onClick={() => onApply({ underline: !currentFormat?.underline || undefined })} />
          <ToggleButton icon="format_strikethrough" label="Strikethrough" checked={!!currentFormat?.strikethrough}
            onClick={() => onApply({ strikethrough: !currentFormat?.strikethrough || undefined })} />
          <span className="w-px h-6 bg-outline-variant mx-1" />
          <ToggleButton icon="format_align_left" label="Align left" checked={currentFormat?.hAlign === 'left'}
            onClick={() => onApply({ hAlign: 'left' })} />
          <ToggleButton icon="format_align_center" label="Align center" checked={currentFormat?.hAlign === 'center'}
            onClick={() => onApply({ hAlign: 'center' })} />
          <ToggleButton icon="format_align_right" label="Align right" checked={currentFormat?.hAlign === 'right'}
            onClick={() => onApply({ hAlign: 'right' })} />
        </div>

        {/* Font family + size stepper */}
        <div className="flex items-center gap-3 mt-3">
          <Select
            value={currentFormat?.fontFamily ?? 'Default'}
            onValueChange={(v: string) => onApply({ fontFamily: v === 'Default' ? undefined : v })}
          >
            <SelectTrigger className="flex-1 min-w-0" data-testid="font-family-select">
              <SelectValue placeholder="Font" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="Default">Default</SelectItem>
              {FONT_FAMILIES.map(f => (
                <SelectItem key={f} value={f} style={{ fontFamily: f }}>{f}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center">
            <button
              aria-label="Decrease font size"
              disabled={smaller.length === 0}
              onClick={() => onApply({ fontSize: smaller[smaller.length - 1] })}
              className="inline-flex items-center justify-center h-10 w-10 rounded-full state-layer disabled:opacity-30"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 20 }}>remove</span>
            </button>
            <span className="w-8 text-center font-mono md-body-large" data-testid="font-size-value">{fontSize}</span>
            <button
              aria-label="Increase font size"
              disabled={larger.length === 0}
              onClick={() => onApply({ fontSize: larger[0] })}
              className="inline-flex items-center justify-center h-10 w-10 rounded-full state-layer disabled:opacity-30"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 20 }}>add</span>
            </button>
          </div>
        </div>

        <SectionLabel>Text color</SectionLabel>
        <ColorGrid
          value={currentFormat?.textColor}
          onChange={(c) => onApply({ textColor: c })}
          onReset={() => onApply({ textColor: undefined })}
          resetLabel="Default"
        />

        <SectionLabel>Fill color</SectionLabel>
        <ColorGrid
          value={currentFormat?.bgColor}
          onChange={(c) => onApply({ bgColor: c })}
          onReset={() => onApply({ bgColor: undefined })}
          resetLabel="No fill"
        />

        <SectionLabel>Number format</SectionLabel>
        <md-list style={{ background: 'transparent' }}>
          {NUMBER_FORMATS.map(nf => {
            const checked = nf.value === 'auto'
              ? !currentFormat?.numFmt
              : currentFormat?.numFmt === nf.value;
            return (
              <md-list-item
                key={nf.value}
                type="button"
                onClick={() => onApply({ numFmt: nf.value === 'auto' ? undefined : nf.value })}
              >
                <md-icon slot="start">{checked ? 'check' : ''}</md-icon>
                <div slot="headline">{nf.label}</div>
                {nf.example && <div slot="supporting-text" className="font-mono">{nf.example}</div>}
              </md-list-item>
            );
          })}
        </md-list>

        <md-divider role="separator" className="my-2" />

        <md-list style={{ background: 'transparent' }}>
          <md-list-item type="button" onClick={() => { onOpenChange(false); onOpenConditional(); }}>
            <md-icon slot="start">auto_awesome</md-icon>
            <div slot="headline">Conditional formatting</div>
          </md-list-item>
          <md-list-item type="button" onClick={() => { onClear(); }}>
            <md-icon slot="start">format_clear</md-icon>
            <div slot="headline">Clear formatting</div>
          </md-list-item>
        </md-list>
        </div>
      </SheetContent>
    </Sheet>
  );
}
