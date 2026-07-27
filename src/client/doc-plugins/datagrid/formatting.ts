import type { DataGridCellFormat, DataGridBorder, FormatRange, ConditionalFormatRule, ConditionalFormatRange } from '../../../shared/schemas/datagrid';
import { sortedEntries } from './helpers';

// ============================================================
// formatToCss — convert DataGridCellFormat to inline CSS styles
// ============================================================

export function formatToCss(format: DataGridCellFormat | undefined): Record<string, string> | undefined {
  if (!format) return undefined;
  const style: Record<string, string> = {};

  if (format.bold) style.fontWeight = 'bold';
  if (format.italic) style.fontStyle = 'italic';

  const decorations: string[] = [];
  if (format.underline) decorations.push('underline');
  if (format.strikethrough) decorations.push('line-through');
  if (decorations.length > 0) style.textDecoration = decorations.join(' ');

  if (format.fontFamily) style.fontFamily = format.fontFamily;
  if (format.fontSize) style.fontSize = `${format.fontSize}pt`;
  if (format.textColor) style.color = format.textColor;
  // Use backgroundColor (NOT the `background` shorthand): the shorthand accepts
  // `url(...)`, so a hostile doc's bgColor could trigger an external fetch. Colors
  // are validated in the schema; this is the defense-in-depth render fix (M3).
  if (format.bgColor) style.backgroundColor = format.bgColor;
  if (format.hAlign) style.textAlign = format.hAlign;
  if (format.vAlign) style.verticalAlign = format.vAlign === 'middle' ? 'middle' : format.vAlign;
  if (format.wrapText) { style.whiteSpace = 'normal'; style.wordWrap = 'break-word'; }

  if (format.borderTop) style.borderTop = borderToCss(format.borderTop);
  if (format.borderBottom) style.borderBottom = borderToCss(format.borderBottom);
  if (format.borderLeft) style.borderLeft = borderToCss(format.borderLeft);
  if (format.borderRight) style.borderRight = borderToCss(format.borderRight);

  return Object.keys(style).length > 0 ? style : undefined;
}

function borderToCss(b: DataGridBorder): string {
  const widthMap: Record<string, string> = { thin: '1px', medium: '2px', thick: '3px' };
  const styleMap: Record<string, string> = {
    thin: 'solid', medium: 'solid', thick: 'solid',
    dashed: 'dashed', dotted: 'dotted', double: 'double',
  };
  const width = widthMap[b.style || 'thin'] || '1px';
  const borderStyle = styleMap[b.style || 'thin'] || 'solid';
  return `${width} ${borderStyle} ${b.color || '#000'}`;
}

// ============================================================
// formatDisplayValue — apply number format to display value
// ============================================================

/** Check if a numFmt is an accounting-style format (currency left, number right). */
export function isAccountingFormat(numFmt: string | undefined): boolean {
  if (!numFmt) return false;
  return numFmt.includes('_($') || numFmt.includes('_($ ') || numFmt.includes('_("$"');
}

export function formatDisplayValue(display: string, numFmt: string | undefined): string {
  if (!numFmt || display === '' || display.startsWith('#')) return display;
  if (numFmt === '@') return display; // Plain text — no formatting
  const num = Number(display);
  if (isNaN(num)) return display;

  // Scientific notation
  if (/[eE]\+/.test(numFmt)) {
    const decMatch = numFmt.match(/0\.(0+)E/i);
    const dec = decMatch ? decMatch[1].length : 2;
    return num.toExponential(dec).toUpperCase();
  }

  // Excel format codes can have up to 4 sections: positive;negative;zero;text
  const sections = numFmt.split(';');
  let section: string;
  if (num > 0 || (num === 0 && sections.length < 3)) {
    section = sections[0];
  } else if (num < 0) {
    section = sections[1] || sections[0];
  } else {
    section = sections[2] || sections[0];
  }

  // Negative section uses absolute value (sign is conveyed by parens or explicit -)
  const absNum = Math.abs(num);

  // Strip color codes like [Red], [Blue], etc.
  section = section.replace(/\[[A-Za-z]+\]/g, '');
  // Strip padding _X (underscore + next char = width spacer)
  section = section.replace(/_./g, '');
  // Strip repeat *X (asterisk + next char = fill)
  section = section.replace(/\*./g, '');
  // Strip quoted literals but keep their content
  section = section.replace(/"([^"]*)"/g, '$1');

  // Detect formatting features from the cleaned section
  const hasParen = section.includes('(') && section.includes(')');
  const hasDollar = section.includes('$');
  const hasComma = /[#0],/.test(section) || /,[#0]/.test(section);
  const hasPercent = section.includes('%');
  const decimalMatch = section.match(/\.([0#?]+)/);
  const decimals = decimalMatch ? decimalMatch[1].length : 0;
  const accounting = isAccountingFormat(numFmt);

  // Handle dash-for-zero pattern: sections like  "-"  or  $ -
  if (num === 0 && (section.includes('-') && !/[#0]/.test(section.replace(/[(),$.%\s]/g, '')))) {
    // For accounting: return just dash ($ is rendered separately by cell)
    return accounting ? '-' : (hasDollar ? '$ -' : '-');
  }

  // Apply percentage scaling
  const val = hasPercent ? absNum * 100 : absNum;

  // Format the number
  let formatted = hasComma
    ? val.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    : val.toFixed(decimals);

  // Accounting format: $ is rendered separately by the cell renderer
  if (accounting) {
    if (num < 0 && hasParen) formatted = '(' + formatted + ')';
    // Add trailing space to match the paren-width padding for positive numbers
    else if (hasParen) formatted = formatted + ' ';
    return formatted;
  }

  // Add currency symbol
  if (hasDollar) formatted = '$ ' + formatted;

  // Add sign: parentheses for negative in paren format, minus sign otherwise
  if (num < 0) {
    if (hasParen) formatted = '(' + formatted + ')';
    else if (!sections[1]) formatted = '-' + formatted; // only add - if using section[0] for negatives
  }

  // Add percent suffix
  if (hasPercent) formatted += '%';

  return formatted;
}

// ============================================================
// computeCellFormat — resolve effective format for a cell from format ranges
// ============================================================

export function computeCellFormat(
  formats: Record<string, FormatRange> | undefined,
  rowId: string,
  colId: string,
  rowIds: string[],
  colIds: string[],
): DataGridCellFormat | undefined {
  if (!formats) return undefined;

  const rowIdx = rowIds.indexOf(rowId);
  const colIdx = colIds.indexOf(colId);
  if (rowIdx === -1 || colIdx === -1) return undefined;

  // Sort ranges by index (ascending) so later overrides earlier
  const sorted = Object.values(formats).sort((a, b) => a.index - b.index);

  let merged: DataGridCellFormat | undefined;
  for (const range of sorted) {
    const rStart = rowIds.indexOf(range.rangeRowStart);
    const rEnd = rowIds.indexOf(range.rangeRowEnd);
    const cStart = colIds.indexOf(range.rangeColStart);
    const cEnd = colIds.indexOf(range.rangeColEnd);
    if (rStart === -1 || rEnd === -1 || cStart === -1 || cEnd === -1) continue;
    if (rowIdx < rStart || rowIdx > rEnd || colIdx < cStart || colIdx > cEnd) continue;

    if (!merged) {
      merged = { ...range.format };
    } else {
      Object.assign(merged, range.format);
    }
  }

  return merged;
}

// ============================================================
// buildFormatCache — precompute format map for all visible cells
// ============================================================

export function buildFormatCache(
  formats: Record<string, FormatRange> | undefined,
  rowIds: string[],
  colIds: string[],
): Map<string, DataGridCellFormat> {
  const cache = new Map<string, DataGridCellFormat>();
  if (!formats) return cache;

  // Sort by index ascending
  const sorted = Object.values(formats).sort((a, b) => a.index - b.index);

  // Build row/col index lookups
  const rowIdxMap = new Map<string, number>();
  rowIds.forEach((id, i) => rowIdxMap.set(id, i));
  const colIdxMap = new Map<string, number>();
  colIds.forEach((id, i) => colIdxMap.set(id, i));

  for (const range of sorted) {
    const rStart = rowIdxMap.get(range.rangeRowStart);
    const rEnd = rowIdxMap.get(range.rangeRowEnd);
    const cStart = colIdxMap.get(range.rangeColStart);
    const cEnd = colIdxMap.get(range.rangeColEnd);
    if (rStart === undefined || rEnd === undefined || cStart === undefined || cEnd === undefined) continue;

    for (let r = rStart; r <= rEnd; r++) {
      for (let c = cStart; c <= cEnd; c++) {
        const key = `${r}:${c}`;
        const existing = cache.get(key);
        if (existing) {
          Object.assign(existing, range.format);
        } else {
          cache.set(key, { ...range.format });
        }
      }
    }
  }

  return cache;
}

// ============================================================
// cellInAnyRange — check if cell falls within any of a rule's ranges
// ============================================================

function cellInAnyRange(
  ranges: Record<string, ConditionalFormatRange>,
  rowIdx: number,
  colIdx: number,
  rowIdxMap: Map<string, number>,
  colIdxMap: Map<string, number>,
): boolean {
  for (const range of Object.values(ranges)) {
    const rStart = rowIdxMap.get(range.rangeRowStart);
    const rEnd = rowIdxMap.get(range.rangeRowEnd);
    const cStart = colIdxMap.get(range.rangeColStart);
    const cEnd = colIdxMap.get(range.rangeColEnd);
    if (rStart === undefined || rEnd === undefined || cStart === undefined || cEnd === undefined) continue;
    if (rowIdx >= rStart && rowIdx <= rEnd && colIdx >= cStart && colIdx <= cEnd) return true;
  }
  return false;
}

/** Build id → index lookup maps for a sheet's row/col id lists. */
export function buildIndexMaps(rowIds: string[], colIds: string[]): { rowIdxMap: Map<string, number>; colIdxMap: Map<string, number> } {
  const rowIdxMap = new Map<string, number>();
  rowIds.forEach((id, i) => rowIdxMap.set(id, i));
  const colIdxMap = new Map<string, number>();
  colIds.forEach((id, i) => colIdxMap.set(id, i));
  return { rowIdxMap, colIdxMap };
}

// ============================================================
// evaluateConditionalFormats — resolve conditional formatting for a cell
// ============================================================

export function evaluateConditionalFormats(
  rules: Record<string, ConditionalFormatRule> | undefined,
  rowId: string,
  colId: string,
  cellValue: string,
  rowIds: string[],
  colIds: string[],
): DataGridCellFormat | undefined {
  if (!rules) return undefined;

  const { rowIdxMap, colIdxMap } = buildIndexMaps(rowIds, colIds);
  const rowIdx = rowIdxMap.get(rowId);
  const colIdx = colIdxMap.get(colId);
  if (rowIdx === undefined || colIdx === undefined) return undefined;

  const sorted = Object.values(rules).sort((a, b) => a.index - b.index);

  for (const rule of sorted) {
    if (!cellInAnyRange(rule.ranges, rowIdx, colIdx, rowIdxMap, colIdxMap)) continue;
    if (matchesCondition(cellValue, rule.conditionType, rule.conditionValue)) {
      return rule.format;
    }
  }

  return undefined;
}

/**
 * Resolve conditional formatting for a cell, combining inline condition checks
 * with HF worker results for customFormula rules. First matching rule wins.
 */
export function resolveConditionalFormat(
  rules: Record<string, ConditionalFormatRule>,
  rowId: string,
  colId: string,
  cellValue: string,
  rowIdxMap: Map<string, number>,
  colIdxMap: Map<string, number>,
  condFormatResults: { matches: Map<string, Set<string>> } | null,
): DataGridCellFormat | undefined {
  // rowIdxMap/colIdxMap are precomputed once per render (id → index) so this hot
  // per-cell path is O(rules × ranges), not O(rules × ranges × rows) of indexOf scans.
  const rowIdx = rowIdxMap.get(rowId);
  const colIdx = colIdxMap.get(colId);
  if (rowIdx === undefined || colIdx === undefined) return undefined;

  const cellKey = `${rowId}:${colId}`;
  // Higher index = higher priority: newly-added rules take precedence.
  const sorted = Object.entries(rules)
    .sort((a, b) => b[1].index - a[1].index);

  for (const [ruleId, rule] of sorted) {
    if (!cellInAnyRange(rule.ranges, rowIdx, colIdx, rowIdxMap, colIdxMap)) continue;

    if (rule.conditionType === 'customFormula') {
      if (condFormatResults?.matches.get(ruleId)?.has(cellKey)) {
        return rule.format;
      }
    } else if (matchesCondition(cellValue, rule.conditionType, rule.conditionValue)) {
      return rule.format;
    }
  }

  return undefined;
}

function matchesCondition(value: string, type: string, conditionValue?: string): boolean {
  const num = Number(value);
  const cond = conditionValue !== undefined ? Number(conditionValue) : NaN;

  switch (type) {
    case 'gt': return !isNaN(num) && !isNaN(cond) && num > cond;
    case 'lt': return !isNaN(num) && !isNaN(cond) && num < cond;
    case 'eq': return value === (conditionValue ?? '');
    case 'neq': return value !== (conditionValue ?? '');
    case 'gte': return !isNaN(num) && !isNaN(cond) && num >= cond;
    case 'lte': return !isNaN(num) && !isNaN(cond) && num <= cond;
    case 'textContains': return conditionValue !== undefined && value.toLowerCase().includes(conditionValue.toLowerCase());
    case 'textStartsWith': return conditionValue !== undefined && value.toLowerCase().startsWith(conditionValue.toLowerCase());
    case 'textEndsWith': return conditionValue !== undefined && value.toLowerCase().endsWith(conditionValue.toLowerCase());
    case 'isEmpty': return value === '';
    case 'isNotEmpty': return value !== '';
    default: return false;
  }
}
