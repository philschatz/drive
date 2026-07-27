import { useState, useCallback } from 'preact/hooks';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { MdTextField } from '@/components/ui/md-text-field';
import { MdSelect } from '@/components/ui/md-select';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { colIndexToLetter, shortId } from './helpers';
import type { ConditionalFormatRule, ConditionalFormatRange, DataGridCellFormat } from '../../../../shared/schemas/datagrid';

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
// ConditionalFormatSheet
// ============================================================

interface ConditionalFormatSheetProps {
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

export function ConditionalFormatSheet({
  open, onOpenChange, rules, sortedRowIds, sortedColIds, currentSheetId, mutate,
  selectedCell, selectionRange, visibleRowIds, visibleColIds,
}: ConditionalFormatSheetProps) {
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
      const c0 = letterToColIndex(m[1].toUpperCase());
      const r0 = parseInt(m[2], 10) - 1;
      const c1 = letterToColIndex(m[3].toUpperCase());
      const r1 = parseInt(m[4], 10) - 1;
      if (r0 < 0 || r1 < 0 || c0 < 0 || c1 < 0) return null;
      // Normalize order so a reversed range (e.g. "C10:A1") still matches cells —
      // containment tests require start <= idx <= end.
      const rowStart = Math.min(r0, r1);
      const rowEnd = Math.max(r0, r1);
      const colStart = Math.min(c0, c1);
      const colEnd = Math.max(c0, c1);
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
      // Patch the existing rule's fields in place rather than replacing the whole
      // object: keeps `index` untouched (so a concurrent reorder isn't clobbered) and
      // merges format keys individually for better CRDT convergence.
      mutate((d: any, sheetId: string, ruleId: string, ranges: any, conditionType: string, storedCondValue: string | undefined, format: any) => {
        const cf = d.sheets[sheetId].conditionalFormats;
        const rule = cf?.[ruleId];
        if (!rule) return;
        rule.ranges = ranges;
        rule.conditionType = conditionType;
        if (storedCondValue !== undefined) rule.conditionValue = storedCondValue;
        else if ('conditionValue' in rule) delete rule.conditionValue;
        if (!rule.format) rule.format = {};
        for (const k of Object.keys(rule.format)) {
          if (!(k in format)) delete rule.format[k];
        }
        for (const [k, v] of Object.entries(format)) {
          rule.format[k] = v;
        }
      }, [currentSheetId, editing, ranges, conditionType, storedCondValue, format]);
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

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      // Escape backs out of the rule editor first, matching PropertySheet's
      // detail→list behaviour; only the list level closes the sheet.
      onEscape={() => { if (!editing) return false; setEditing(null); return true; }}
    >
      <SheetContent side="bottom" className="max-h-[85vh] p-4">
      <SheetHeader>
        <SheetTitle>Conditional Formatting</SheetTitle>
      </SheetHeader>

      {/* SheetContent doesn't forward extra props — testid goes on a wrapper */}
      <div className="space-y-3 mt-2" data-testid="cond-format-sheet">
        {editing ? (
          // Editor
          <div className="space-y-3">
            <MdTextField
              label="Ranges"
              data-testid="cf-ranges"
              value={rangeText}
              onInput={setRangeText}
              placeholder="A1:C10, E1:E20"
              supportingText="e.g. A1:C10, E1:E20"
            />
            <MdSelect
              label="Condition"
              data-testid="cf-condition"
              value={conditionType}
              options={CONDITION_TYPES.map(c => ({ value: c.value, label: c.label }))}
              onValueChange={setConditionType}
            />
            {!NO_VALUE_CONDITIONS.has(conditionType) && (
              <MdTextField
                label={conditionType === 'customFormula' ? 'Formula' : 'Value'}
                data-testid="cf-value"
                value={conditionValue}
                onInput={setConditionValue}
                placeholder={conditionType === 'customFormula' ? '=RC>10' : 'Enter value...'}
                supportingText={conditionType === 'customFormula'
                  ? 'R1C1 notation, relative to each cell. RC = this cell, R[-1]C = cell above, R1C1 = absolute A1.'
                  : undefined}
              />
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
            {/* Material list, matching the app's other option sheets. Tapping a
                row edits the rule; reorder/delete stay as trailing icon buttons
                since they act without leaving the list. */}
            <md-list style={{ background: 'transparent' }}>
              {(() => {
                const applicable = sortedRules.filter(([, rule]) => ruleAppliesToSelection(rule));
                const other = sortedRules.filter(([, rule]) => !ruleAppliesToSelection(rule));
                const combined: ([string, ConditionalFormatRule] | 'divider')[] = [...applicable];
                if (applicable.length > 0 && other.length > 0) combined.push('divider');
                combined.push(...other);
                return combined;
              })().map((item) => {
                if (item === 'divider') {
                  return <md-divider key="divider" role="separator" />;
                }
                const [id, rule] = item;
                const applies = ruleAppliesToSelection(rule);
                const priorityIdx = sortedRules.findIndex(([rid]) => rid === id);
                const isFirst = priorityIdx === 0;
                const isLast = priorityIdx === sortedRules.length - 1;
                return (
                <md-list-item
                  key={id}
                  type="button"
                  data-testid={`cf-rule-${id}`}
                  style={applies ? undefined : { opacity: 0.4 }}
                  onClick={() => startEdit(id)}
                >
                  <div slot="headline" className="truncate">
                    {rule.conditionType === 'customFormula'
                      ? (rule.conditionValue ?? '')
                      : `${condLabel(rule.conditionType)}${rule.conditionValue ? ` ${rule.conditionValue}` : ''}`}
                  </div>
                  <div slot="supporting-text">{rangeToA1(rule)}</div>
                  <div slot="end" className="flex items-center gap-1">
                    <div
                      className="w-6 h-6 rounded-sm border flex-shrink-0"
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
                    {/* stopPropagation — the row itself opens the editor. */}
                    {!isFirst && (
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={(e: any) => { e.stopPropagation(); moveRule(id, 'up'); }} title="Move up (lower priority)">
                        <span className="material-symbols-outlined" style={{ fontSize: '1rem' }}>arrow_upward</span>
                      </Button>
                    )}
                    {!isLast && (
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={(e: any) => { e.stopPropagation(); moveRule(id, 'down'); }} title="Move down (higher priority)">
                        <span className="material-symbols-outlined" style={{ fontSize: '1rem' }}>arrow_downward</span>
                      </Button>
                    )}
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={(e: any) => { e.stopPropagation(); deleteRule(id); }} title="Delete rule">
                      <span className="material-symbols-outlined" style={{ fontSize: '1rem', color: 'var(--md-sys-color-error)' }}>delete</span>
                    </Button>
                  </div>
                </md-list-item>
                );
              })}
              <md-divider role="separator" />
              <md-list-item type="button" data-testid="cf-add-rule" onClick={startNew}>
                <md-icon slot="start">add</md-icon>
                <div slot="headline">Add rule</div>
              </md-list-item>
            </md-list>
          </>
        )}
      </div>
      </SheetContent>
    </Sheet>
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
