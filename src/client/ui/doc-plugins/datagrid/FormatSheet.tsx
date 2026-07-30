import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { FONT_SIZES, NUMBER_FORMATS } from './format-presets';
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
  onOpenNumberFormat,
  onOpenFontFamily,
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
  /** Open the number-format picker (a sibling sheet, so this one stays open). */
  onOpenNumberFormat: () => void;
  /** Open the font-family picker (likewise a sibling). */
  onOpenFontFamily: () => void;
}) {
  const fontSize = currentFormat?.fontSize ?? 11;
  const smaller = FONT_SIZES.filter(s => s < fontSize);
  const larger = FONT_SIZES.filter(s => s > fontSize);
  const numFmtLabel = NUMBER_FORMATS.find(
    nf => nf.value === (currentFormat?.numFmt ?? 'auto'),
  )?.label ?? 'Custom';

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

        {/* Font size stays a stepper: it is a value on a scale, stepped far more
            often than it is jumped, so two 40px targets beat a list of fourteen. */}
        <div className="flex items-center justify-between mt-3 px-4">
          <span className="md-body-large">Font size</span>
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

        <md-divider role="separator" className="my-3" />

        {/* Font and number format are one row each, not two inline lists of ten and
            fourteen — those pushed everything below them off-screen. Each opens a
            sibling picker sheet (like the colour picker), so this sheet stays put
            behind it and the current value reads in the row's supporting text. */}
        <md-list style={{ background: 'transparent' }}>
          <md-list-item type="button" data-testid="font-family-row" onClick={onOpenFontFamily}>
            <md-icon slot="start">font_download</md-icon>
            <div slot="headline">Font</div>
            {/* Set in the font it names — the preview is the point. */}
            <div slot="supporting-text" style={{ fontFamily: currentFormat?.fontFamily ?? undefined }}>
              {currentFormat?.fontFamily ?? 'Default'}
            </div>
            <md-icon slot="end" aria-hidden="true">chevron_right</md-icon>
          </md-list-item>
          <md-list-item type="button" data-testid="number-format-row" onClick={onOpenNumberFormat}>
            <md-icon slot="start">123</md-icon>
            <div slot="headline">Number format</div>
            <div slot="supporting-text">{numFmtLabel}</div>
            <md-icon slot="end" aria-hidden="true">chevron_right</md-icon>
          </md-list-item>
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
