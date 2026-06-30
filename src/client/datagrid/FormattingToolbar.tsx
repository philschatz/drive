import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import {
  Select, SelectTrigger, SelectContent, SelectItem,
} from '@/components/ui/select';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
} from '@/components/ui/dropdown-menu';
import type { DataGridCellFormat } from './schema';

// ============================================================
// Preset data
// ============================================================

export const FONT_FAMILIES = [
  'Arial', 'Courier New', 'Georgia', 'Helvetica', 'Times New Roman', 'Verdana',
  'Trebuchet MS', 'Comic Sans MS', 'Impact', 'Lucida Console',
];

export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72];

export const NUMBER_FORMATS: { label: string; value: string; example?: string }[] = [
  { label: 'Automatic', value: 'auto' },
  { label: 'Plain text', value: '@' },
  { label: 'Number', value: '#,##0.00', example: '1,234.56' },
  { label: 'Integer', value: '#,##0', example: '1,235' },
  { label: 'Accounting', value: '_($* #,##0.00_);_($* (#,##0.00);_($* "-"_);_(@_)', example: '$ (1,234.56)' },
  { label: 'Percent', value: '0.00%', example: '12.35%' },
  { label: 'Scientific', value: '0.00E+0', example: '1.23E+3' },
  { label: 'Date', value: 'mm/dd/yyyy', example: '04/02/2026' },
  { label: 'Time', value: 'hh:mm:ss', example: '14:30:00' },
  { label: 'Datetime', value: 'mm/dd/yyyy hh:mm', example: '04/02/2026 14:30' },
];

export const PRESET_COLORS = [
  '#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff',
  '#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff',
  '#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc',
  '#dd7e6b', '#ea9999', '#f9cb9c', '#ffe599', '#b6d7a8', '#a2c4c9', '#a4c2f4', '#9fc5e8', '#b4a7d6', '#d5a6bd',
  '#cc4125', '#e06666', '#f6b26b', '#ffd966', '#93c47d', '#76a5af', '#6d9eeb', '#6fa8dc', '#8e7cc3', '#c27ba0',
];

export const BORDER_PRESETS: { label: string; icon: string; sides: string[] }[] = [
  { label: 'All borders', icon: 'border_all', sides: ['borderTop', 'borderBottom', 'borderLeft', 'borderRight'] },
  { label: 'Outer borders', icon: 'border_outer', sides: ['borderTop', 'borderBottom', 'borderLeft', 'borderRight'] },
  { label: 'No borders', icon: 'border_clear', sides: [] },
  { label: 'Top border', icon: 'border_top', sides: ['borderTop'] },
  { label: 'Bottom border', icon: 'border_bottom', sides: ['borderBottom'] },
  { label: 'Left border', icon: 'border_left', sides: ['borderLeft'] },
  { label: 'Right border', icon: 'border_right', sides: ['borderRight'] },
];

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
        <SelectTrigger className="h-7 w-[120px] text-xs" placeholder="Font" />
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
        <SelectTrigger className="h-7 w-[56px] text-xs" placeholder="Size" />
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
        <SelectTrigger className="h-7 w-[100px] text-xs" placeholder="Format" />
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

export function ColorPicker({ value, onChange, onReset, icon, title, disabled, defaultColor = '#000' }: {
  value?: string;
  onChange: (color: string) => void;
  onReset?: () => void;
  icon: string;
  title: string;
  disabled?: boolean;
  defaultColor?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7 relative" disabled={disabled} title={title}>
          <Icon name={icon} size="1rem" />
          <div
            className="absolute bottom-0.5 left-1.5 right-1.5 h-0.5 rounded-sm"
            style={{ background: value || defaultColor }}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="p-2 w-auto" align="start">
        {onReset && (
          <button
            className="w-full text-left text-xs px-2 py-1 mb-2 rounded hover:bg-accent cursor-pointer flex items-center gap-1"
            onClick={onReset}
          >
            <Icon name="format_color_reset" size="0.9rem" />
            No fill
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
          <Icon name="border_all" size="1rem" />
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
              <Icon name={preset.icon} size="1.1rem" />
            </button>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
