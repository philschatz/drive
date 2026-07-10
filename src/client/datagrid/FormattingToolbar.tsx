import { Button } from '@/components/ui/button';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
} from '@/components/ui/dropdown-menu';
import type { DataGridCellFormat } from './schema';
import {
  FONT_FAMILIES, FONT_SIZES, NUMBER_FORMATS, PRESET_COLORS, BORDER_PRESETS,
} from './format-presets';

// Re-export preset data (moved to format-presets.ts, a UI-free module) so
// existing consumers importing them from here keep working.
export {
  FONT_FAMILIES, FONT_SIZES, NUMBER_FORMATS, PRESET_COLORS, BORDER_PRESETS,
} from './format-presets';

// ============================================================
// FormattingToolbar
// ============================================================

interface FormattingToolbarProps {
  currentFormat: DataGridCellFormat | undefined;
  hasSelection: boolean;
  onFormatChange: (patch: Partial<DataGridCellFormat>) => void;
}

export function FormattingToolbar({ currentFormat, hasSelection, onFormatChange }: FormattingToolbarProps) {
  return (
    <div className="flex items-center gap-1">
      {/* Font family */}
      <div className="w-px h-6 bg-border mx-1" />
      <Select
        value={currentFormat?.fontFamily || 'default'}
        onValueChange={(v: string) => onFormatChange({ fontFamily: v === 'default' ? undefined : v })}
        disabled={!hasSelection}
      >
        <SelectTrigger className="h-7 w-[120px] text-xs">
          <SelectValue placeholder="Font" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="default">Default</SelectItem>
          {FONT_FAMILIES.map(f => (
            <SelectItem key={f} value={f} style={{ fontFamily: f }}>{f}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Font size */}
      <Select
        value={currentFormat?.fontSize ? String(currentFormat.fontSize) : 'default'}
        onValueChange={(v: string) => onFormatChange({ fontSize: v === 'default' ? undefined : Number(v) })}
        disabled={!hasSelection}
      >
        <SelectTrigger className="h-7 w-[56px] text-xs">
          <SelectValue placeholder="Size" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="default">-</SelectItem>
          {FONT_SIZES.map(s => (
            <SelectItem key={s} value={String(s)}>{s}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Text color */}
      <ColorPicker
        value={currentFormat?.textColor}
        onChange={(c) => onFormatChange({ textColor: c })}
        icon="format_color_text"
        title="Text color"
        disabled={!hasSelection}
      />

      {/* Background color */}
      <ColorPicker
        value={currentFormat?.bgColor}
        onChange={(c) => onFormatChange({ bgColor: c })}
        icon="format_color_fill"
        title="Fill color"
        disabled={!hasSelection}
      />

      {/* Number format */}
      <div className="w-px h-6 bg-border mx-1" />
      <Select
        value={currentFormat?.numFmt || 'auto'}
        onValueChange={(v: string) => onFormatChange({ numFmt: v === 'auto' ? undefined : v })}
        disabled={!hasSelection}
      >
        <SelectTrigger className="h-7 w-[100px] text-xs">
          <SelectValue placeholder="Format" />
        </SelectTrigger>
        <SelectContent>
          {NUMBER_FORMATS.map(f => (
            <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Borders */}
      <BorderPicker
        onApply={(sides) => {
          const patch: Partial<DataGridCellFormat> = {};
          const allSides = ['borderTop', 'borderBottom', 'borderLeft', 'borderRight'] as const;
          const sideSet = new Set(sides);
          for (const side of allSides) {
            if (sideSet.has(side)) {
              (patch as any)[side] = { style: 'thin', color: '#000000' };
            } else {
              (patch as any)[side] = undefined;
            }
          }
          onFormatChange(patch);
        }}
        disabled={!hasSelection}
      />
    </div>
  );
}

// ============================================================
// ColorPicker
// ============================================================

// The inner content of a color picker — a reset option, the preset grid, and a
// custom color input. Shared by the toolbar ColorPicker dropdown and the menubar
// color submenus so both look and behave identically.
export function ColorPickerContent({ value, onChange, onReset, resetLabel = 'No fill' }: {
  value?: string;
  onChange: (color: string) => void;
  onReset?: () => void;
  resetLabel?: string;
}) {
  return (
    <>
      {onReset && (
        <button
          className="w-full text-left text-xs px-2 py-1 mb-2 rounded hover:bg-accent cursor-pointer flex items-center gap-1"
          onClick={onReset}
        >
          <span className="material-symbols-outlined" style={{ fontSize: '0.9rem' }}>format_color_reset</span>
          {resetLabel}
        </button>
      )}
      <div className="grid grid-cols-10 gap-1 mb-2">
        {PRESET_COLORS.map(color => (
          <button
            key={color}
            className="w-5 h-5 rounded-sm border border-gray-300 cursor-pointer hover:ring-2 ring-blue-500 focus:ring-2 focus:outline-none"
            style={{ background: color }}
            title={color}
            onClick={() => onChange(color)}
          />
        ))}
      </div>
      <div className="flex items-center gap-2 mt-1 pt-1 border-t">
        <span className="text-xs text-muted-foreground">Custom:</span>
        <input
          type="color"
          value={value || '#000000'}
          onChange={(e) => onChange((e.target as HTMLInputElement).value)}
          className="w-6 h-6 cursor-pointer border-0 p-0"
        />
      </div>
    </>
  );
}

export function ColorPicker({ value, onChange, onReset, resetLabel, icon, title, disabled, defaultColor = '#000' }: {
  value?: string;
  onChange: (color: string) => void;
  onReset?: () => void;
  resetLabel?: string;
  icon: string;
  title: string;
  disabled?: boolean;
  defaultColor?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7 relative" disabled={disabled} title={title}>
          <span className="material-symbols-outlined" style={{ fontSize: '1rem' }}>{icon}</span>
          <div
            className="absolute bottom-0.5 left-1.5 right-1.5 h-0.5 rounded-sm"
            style={{ background: value || defaultColor }}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="p-2 w-auto" align="start">
        <ColorPickerContent value={value} onChange={onChange} onReset={onReset} resetLabel={resetLabel} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ============================================================
// BorderPicker
// ============================================================

export function BorderPicker({ onApply, disabled }: {
  onApply: (sides: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" className="h-7 w-7" disabled={disabled} title="Borders">
          <span className="material-symbols-outlined" style={{ fontSize: '1rem' }}>border_all</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="p-2 w-auto" align="start">
        <div className="grid grid-cols-4 gap-1">
          {BORDER_PRESETS.map(preset => (
            <button
              key={preset.icon}
              className="w-8 h-8 rounded-sm border border-gray-200 cursor-pointer hover:bg-accent flex items-center justify-center focus:ring-2 focus:outline-none"
              title={preset.label}
              onClick={() => onApply(preset.sides)}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '1.1rem' }}>{preset.icon}</span>
            </button>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
