import { useState, useEffect, useCallback } from 'preact/hooks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select';
import { colIndexToLetter, shortId } from './helpers';
import type { ConditionalFormatRule, ConditionalFormatRange, DataGridCellFormat } from './schema';

// ============================================================
// Types
// ============================================================

const CONDITION_TYPES: { value: string; label: string }[] = [
  { value: 'gt', label: 'Greater than' },
  { value: 'lt', label: 'Less than' },
  { value: 'eq', label: 'Equal to' },
  { value: 'neq', label: 'Not equal to' },
  { value: 'gte', label: 'Greater than or equal' },
  { value: 'lte', label: 'Less than or equal' },
  { value: 'textContains', label: 'Text contains' },
  { value: 'textStartsWith', label: 'Text starts with' },
  { value: 'textEndsWith', label: 'Text ends with' },
  { value: 'isEmpty', label: 'Is empty' },
  { value: 'isNotEmpty', label: 'Is not empty' },
  { value: 'customFormula', label: 'Custom formula' },
];

const NO_VALUE_CONDITIONS = new Set(['isEmpty', 'isNotEmpty']);

// ============================================================
// ConditionalFormatPanel
// ============================================================

interface ConditionalFormatPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rules: Record<string, ConditionalFormatRule> | undefined;
  sortedRowIds: string[];
  sortedColIds: string[];
  currentSheetId: string;
  mutate: (fn: (doc: any, ...args: any[]) => void, args: unknown[]) => void;
  selectedCell: [number, number] | null;
  selectionRange: { minCol: number; maxCol: number; minRow: number; maxRow: number } | null;
  visibleRowIds: string[];
  visibleColIds: string[];
}

export function ConditionalFormatPanel({
  open, onOpenChange, rules, sortedRowIds, sortedColIds, currentSheetId, mutate,
  selectedCell, selectionRange, visibleRowIds, visibleColIds,
}: ConditionalFormatPanelProps) {
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [rangeText, setRangeText] = useState('');
  const [conditionType, setConditionType] = useState('gt');
  const [conditionValue, setConditionValue] = useState('');
  const [fmtBold, setFmtBold] = useState(false);
  const [fmtItalic, setFmtItalic] = useState(false);
  const [fmtTextColor, setFmtTextColor] = useState('#000000');
  const [fmtBgColor, setFmtBgColor] = useState('#ffff00');

  // Display in ascending index order: lowest priority at the top, highest
  // priority at the bottom. Evaluation priority is unchanged — rules with
  // larger index still win (see resolveConditionalFormat in formatting.ts).
  const sortedRules = rules
    ? Object.entries(rules).sort((a, b) => a[1].index - b[1].index)
    : [];

  // Determine which rules apply to the current selection
  const ruleAppliesToSelection = useCallback((rule: ConditionalFormatRule): boolean => {
    if (!selectedCell) return false;
    // Build set of selected cell positions (row/col indices in sorted arrays)
    const cells: [number, number][] = [];
    if (selectionRange) {
      for (let r = selectionRange.minRow; r <= selectionRange.maxRow; r++) {
        for (let c = selectionRange.minCol; c <= selectionRange.maxCol; c++) {
          if (r < visibleRowIds.length && c < visibleColIds.length) {
            const ri = sortedRowIds.indexOf(visibleRowIds[r]);
            const ci = sortedColIds.indexOf(visibleColIds[c]);
            if (ri !== -1 && ci !== -1) cells.push([ri, ci]);
          }
        }
      }
    } else {
      const [col, row] = selectedCell;
      if (row < visibleRowIds.length && col < visibleColIds.length) {
        const ri = sortedRowIds.indexOf(visibleRowIds[row]);
        const ci = sortedColIds.indexOf(visibleColIds[col]);
        if (ri !== -1 && ci !== -1) cells.push([ri, ci]);
      }
    }
    // Check if any selected cell falls in any of the rule's ranges
    for (const [rowIdx, colIdx] of cells) {
      for (const range of Object.values(rule.ranges)) {
        const rStart = sortedRowIds.indexOf(range.rangeRowStart);
        const rEnd = sortedRowIds.indexOf(range.rangeRowEnd);
        const cStart = sortedColIds.indexOf(range.rangeColStart);
        const cEnd = sortedColIds.indexOf(range.rangeColEnd);
        if (rStart === -1 || rEnd === -1 || cStart === -1 || cEnd === -1) continue;
        if (rowIdx >= rStart && rowIdx <= rEnd && colIdx >= cStart && colIdx <= cEnd) return true;
      }
    }
    return false;
  }, [selectedCell, selectionRange, visibleRowIds, visibleColIds, sortedRowIds, sortedColIds]);

  const rangeToA1 = (rule: ConditionalFormatRule): string => {
    return Object.values(rule.ranges).map(range => {
      const rStart = sortedRowIds.indexOf(range.rangeRowStart);
      const rEnd = sortedRowIds.indexOf(range.rangeRowEnd);
      const cStart = sortedColIds.indexOf(range.rangeColStart);
      const cEnd = sortedColIds.indexOf(range.rangeColEnd);
      if (rStart === -1 || rEnd === -1 || cStart === -1 || cEnd === -1) return '?';
      return `${colIndexToLetter(cStart)}${rStart + 1}:${colIndexToLetter(cEnd)}${rEnd + 1}`;
    }).join(', ');
  };

  const parseA1Ranges = (text: string): Record<string, ConditionalFormatRange> | null => {
    const segments = text.split(',').map(s => s.trim()).filter(Boolean);
    if (segments.length === 0) return null;

    const ranges: Record<string, ConditionalFormatRange> = {};
    for (const seg of segments) {
      const m = seg.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
      if (!m) return null;
      const colStart = letterToColIndex(m[1].toUpperCase());
      const rowStart = parseInt(m[2], 10) - 1;
      const colEnd = letterToColIndex(m[3].toUpperCase());
      const rowEnd = parseInt(m[4], 10) - 1;
      if (rowStart < 0 || rowEnd < 0 || colStart < 0 || colEnd < 0) return null;
      if (rowStart >= sortedRowIds.length || rowEnd >= sortedRowIds.length) return null;
      if (colStart >= sortedColIds.length || colEnd >= sortedColIds.length) return null;
      ranges[shortId()] = {
        rangeRowStart: sortedRowIds[rowStart],
        rangeRowEnd: sortedRowIds[rowEnd],
        rangeColStart: sortedColIds[colStart],
        rangeColEnd: sortedColIds[colEnd],
      };
    }
    return Object.keys(ranges).length > 0 ? ranges : null;
  };

  const startEdit = (id: string) => {
    const rule = rules?.[id];
    if (!rule) return;
    setEditing(id);
    setRangeText(rangeToA1(rule));
    setConditionType(rule.conditionType);
    setConditionValue(rule.conditionValue ?? '');
    setFmtBold(!!rule.format.bold);
    setFmtItalic(!!rule.format.italic);
    setFmtTextColor(rule.format.textColor || '#000000');
    setFmtBgColor(rule.format.bgColor || '#ffff00');
  };

  const startNew = () => {
    setEditing('new');
    setRangeText('');
    setConditionType('gt');
    setConditionValue('');
    setFmtBold(false);
    setFmtItalic(false);
    setFmtTextColor('#000000');
    setFmtBgColor('#ffff00');
  };

  const save = () => {
    const ranges = parseA1Ranges(rangeText);
    if (!ranges) return;

    const format: DataGridCellFormat = {};
    if (fmtBold) format.bold = true;
    if (fmtItalic) format.italic = true;
    if (fmtTextColor !== '#000000') format.textColor = fmtTextColor;
    format.bgColor = fmtBgColor;

    // customFormula stores R1C1 verbatim (relative to each target cell).
    // The worker re-anchors R[offset]C[offset] to each cell at evaluation time.
    let storedCondValue: string | undefined;
    if (conditionType === 'customFormula' && conditionValue) {
      storedCondValue = conditionValue.startsWith('=') ? conditionValue : '=' + conditionValue;
    } else if (!NO_VALUE_CONDITIONS.has(conditionType)) {
      storedCondValue = conditionValue;
    }

    if (editing === 'new') {
      let maxIndex = 0;
      if (rules) {
        for (const r of Object.values(rules)) {
          if (r.index > maxIndex) maxIndex = r.index;
        }
      }
      const newId = shortId();
      const entry: any = {
        index: maxIndex + 1,
        ranges,
        conditionType,
        ...(storedCondValue !== undefined ? { conditionValue: storedCondValue } : {}),
        format,
      };
      mutate((d: any, sheetId: string, newId: string, entry: any) => {
        const ms = d.sheets[sheetId];
        if (!ms.conditionalFormats) ms.conditionalFormats = {};
        ms.conditionalFormats[newId] = entry;
      }, [currentSheetId, newId, entry]);
    } else if (editing) {
      const entry: any = {
        index: rules![editing].index,
        ranges,
        conditionType,
        ...(storedCondValue !== undefined ? { conditionValue: storedCondValue } : {}),
        format,
      };
      mutate((d: any, sheetId: string, ruleId: string, entry: any) => {
        d.sheets[sheetId].conditionalFormats[ruleId] = entry;
      }, [currentSheetId, editing, entry]);
    }
    setEditing(null);
  };

  const deleteRule = (id: string) => {
    mutate((d: any, sheetId: string, ruleId: string) => {
      if (d.sheets[sheetId].conditionalFormats) {
        delete d.sheets[sheetId].conditionalFormats[ruleId];
      }
    }, [currentSheetId, id]);
  };

  // Swap the rule's index with its neighbor in sorted-by-index order.
  // Lower index = higher priority (evaluated first), so "up" = lower index.
  const moveRule = (id: string, direction: 'up' | 'down') => {
    const ids = sortedRules.map(([rid]) => rid);
    const idx = ids.indexOf(id);
    const neighborIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (neighborIdx < 0 || neighborIdx >= ids.length) return;
    const neighborId = ids[neighborIdx];
    mutate((d: any, sheetId: string, aId: string, bId: string) => {
      const cf = d.sheets[sheetId].conditionalFormats;
      if (!cf || !cf[aId] || !cf[bId]) return;
      const tmp = cf[aId].index;
      cf[aId].index = cf[bId].index;
      cf[bId].index = tmp;
    }, [currentSheetId, id, neighborId]);
  };

  const condLabel = (type: string) =>
    CONDITION_TYPES.find(c => c.value === type)?.label ?? type;

  const handleClose = useCallback(() => onOpenChange(false), [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, handleClose]);

  if (!open) return null;

  return (
    <div className="cond-format-panel">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Conditional Formatting</h2>
        <button
          className="rounded-sm opacity-70 hover:opacity-100 focus:outline-none"
          onClick={handleClose}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>

      <div className="space-y-3">
        {editing ? (
          // Editor
          <div className="space-y-3">
            <div>
              <Label>Ranges (e.g. A1:C10, E1:E20)</Label>
              <Input
                value={rangeText}
                onInput={(e: any) => setRangeText(e.target.value)}
                placeholder="A1:C10, E1:E20"
                className="mt-1"
              />
            </div>
            <div>
              <Label>Condition</Label>
              <Select value={conditionType} onValueChange={setConditionType}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONDITION_TYPES.map(c => (
                    <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {!NO_VALUE_CONDITIONS.has(conditionType) && (
              <div>
                <Label>{conditionType === 'customFormula' ? 'Formula' : 'Value'}</Label>
                <Input
                  value={conditionValue}
                  onInput={(e: any) => setConditionValue(e.target.value)}
                  placeholder={conditionType === 'customFormula' ? '=RC>10' : 'Enter value...'}
                  className="mt-1"
                />
                {conditionType === 'customFormula' && (
                  <p className="text-xs text-muted-foreground mt-1">
                    R1C1 notation, relative to each cell. <code>RC</code> = this cell, <code>R[-1]C</code> = cell above, <code>R1C1</code> = absolute A1.
                  </p>
                )}
              </div>
            )}
            <div>
              <Label>Formatting</Label>
              <div className="flex items-center gap-2 mt-1">
                <Button
                  variant={fmtBold ? 'active' : 'outline'}
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setFmtBold(!fmtBold)}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '1rem' }}>format_bold</span>
                </Button>
                <Button
                  variant={fmtItalic ? 'active' : 'outline'}
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setFmtItalic(!fmtItalic)}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '1rem' }}>format_italic</span>
                </Button>
                <div className="flex items-center gap-1">
                  <span className="text-xs text-muted-foreground">Text:</span>
                  <input
                    type="color"
                    value={fmtTextColor}
                    onChange={(e: any) => setFmtTextColor(e.target.value)}
                    className="w-6 h-6 cursor-pointer border-0 p-0"
                  />
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-xs text-muted-foreground">Fill:</span>
                  <input
                    type="color"
                    value={fmtBgColor}
                    onChange={(e: any) => setFmtBgColor(e.target.value)}
                    className="w-6 h-6 cursor-pointer border-0 p-0"
                  />
                </div>
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <Button onClick={save} size="sm">Save</Button>
              <Button onClick={() => setEditing(null)} variant="outline" size="sm">Cancel</Button>
            </div>
          </div>
        ) : (
          // Rule list — applicable rules first, then non-applicable greyed out
          <>
            {sortedRules.length === 0 && (
              <p className="text-sm text-muted-foreground">No conditional formatting rules.</p>
            )}
            {(() => {
              const applicable = sortedRules.filter(([, rule]) => ruleAppliesToSelection(rule));
              const other = sortedRules.filter(([, rule]) => !ruleAppliesToSelection(rule));
              const combined: ([string, ConditionalFormatRule] | 'divider')[] = [...applicable];
              if (applicable.length > 0 && other.length > 0) combined.push('divider');
              combined.push(...other);
              return combined;
            })().map((item) => {
              if (item === 'divider') {
                return <div key="divider" className="border-t my-1" />;
              }
              const [id, rule] = item;
              const applies = ruleAppliesToSelection(rule);
              const priorityIdx = sortedRules.findIndex(([rid]) => rid === id);
              const isFirst = priorityIdx === 0;
              const isLast = priorityIdx === sortedRules.length - 1;
              return (
              <div key={id} className={'flex items-center justify-between border rounded-md p-2 text-sm' + (applies ? '' : ' opacity-40')}>
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">
                    {rule.conditionType === 'customFormula'
                      ? (rule.conditionValue ?? '')
                      : `${condLabel(rule.conditionType)}${rule.conditionValue ? ` ${rule.conditionValue}` : ''}`}
                  </div>
                  <div className="text-xs text-muted-foreground">{rangeToA1(rule)}</div>
                </div>
                <div
                  className="w-6 h-6 rounded-sm border mx-2 flex-shrink-0"
                  style={{
                    background: rule.format.bgColor || 'transparent',
                    color: rule.format.textColor || '#000',
                    fontWeight: rule.format.bold ? 'bold' : 'normal',
                    fontStyle: rule.format.italic ? 'italic' : 'normal',
                    fontSize: '0.7rem',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  title="Format preview"
                >
                  Ab
                </div>
                <div className="flex gap-1">
                  {!isFirst && (
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => moveRule(id, 'up')} title="Move up (lower priority)">
                      <span className="material-symbols-outlined" style={{ fontSize: '1rem' }}>arrow_upward</span>
                    </Button>
                  )}
                  {!isLast && (
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => moveRule(id, 'down')} title="Move down (higher priority)">
                      <span className="material-symbols-outlined" style={{ fontSize: '1rem' }}>arrow_downward</span>
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => startEdit(id)}>
                    <span className="material-symbols-outlined" style={{ fontSize: '1rem' }}>edit</span>
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => deleteRule(id)}>
                    <span className="material-symbols-outlined" style={{ fontSize: '1rem' }}>delete</span>
                  </Button>
                </div>
              </div>
              );
            })}
            <Button onClick={startNew} size="sm" className="mt-2">
              <span className="material-symbols-outlined mr-1" style={{ fontSize: '1rem' }}>add</span>
              Add rule
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Helpers
// ============================================================

function letterToColIndex(letters: string): number {
  let idx = 0;
  for (let i = 0; i < letters.length; i++) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64);
  }
  return idx - 1;
}
