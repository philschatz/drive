// ============================================================
// Format presets — pure data, no UI dependencies.
// Extracted from FormattingToolbar so the command layer (commands.ts)
// can consume them without pulling in the Preact/Radix component chain
// (keeps commands.ts unit-testable in a plain Node environment).
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
