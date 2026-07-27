import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select';
import { FONT_FAMILIES, FONT_SIZES, NUMBER_FORMATS } from './format-presets';
import type { DataGridCellFormat } from '../../../../shared/schemas/datagrid';
import type { ColorTarget } from './ColorSheet';

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
 * Icon button previewing the colour it edits (an underline swatch, like the
 * desktop pickers) — tapping it opens the colour subsheet.
 */
function ColorButton({
  icon,
  label,
  color,
  fallback,
  onClick,
}: {
  icon: string;
  label: string;
  color: string | undefined;
  /** Swatch shown when no colour is set. */
  fallback: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      data-testid={`format-${icon}`}
      className="relative inline-flex items-center justify-center h-10 w-10 rounded-full state-layer shrink-0"
    >
      <span className="material-symbols-outlined" style={{ fontSize: 22 }}>{icon}</span>
      <span
        aria-hidden="true"
        className="absolute bottom-1 left-2 right-2 h-1 rounded-sm border border-outline-variant"
        style={{ background: color ?? fallback }}
      />
    </button>
  );
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
  onOpenColor,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resolved format of the primary selected cell (toggle/checked state). */
  currentFormat: DataGridCellFormat | undefined;
  /** Apply a patch to the selection (undefined values delete keys). */
  onApply: (patch: Partial<DataGridCellFormat>) => void;
  onClear: () => void;
  onOpenConditional: () => void;
  /** Open the colour-only sheet for text or fill. */
  onOpenColor: (target: ColorTarget) => void;
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
          <span className="w-px h-6 bg-outline-variant mx-1" />
          {/* Colours live in their own subsheets; the swatch shows the current one. */}
          <ColorButton
            icon="format_color_text"
            label="Text color"
            color={currentFormat?.textColor}
            fallback="var(--md-sys-color-on-surface)"
            onClick={() => onOpenColor('text')}
          />
          <ColorButton
            icon="format_color_fill"
            label="Fill color"
            color={currentFormat?.bgColor}
            fallback="transparent"
            onClick={() => onOpenColor('fill')}
          />
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
