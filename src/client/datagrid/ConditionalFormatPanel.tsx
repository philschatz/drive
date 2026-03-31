import { useState } from 'preact/hooks';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select';
import { sortedEntries, colIndexToLetter, shortId, a1ToInternal, internalToA1 } from './helpers';
import type { ConditionalFormatRule, DataGridCellFormat } from './schema';

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
}

export function ConditionalFormatPanel({
  open, onOpenChange, rules, sortedRowIds, sortedColIds, currentSheetId, mutate,
}: ConditionalFormatPanelProps) {
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [rangeText, setRangeText] = useState('');
  const [conditionType, setConditionType] = useState('gt');
  const [conditionValue, setConditionValue] = useState('');
  const [fmtBold, setFmtBold] = useState(false);
  const [fmtItalic, setFmtItalic] = useState(false);
  const [fmtTextColor, setFmtTextColor] = useState('#000000');
  const [fmtBgColor, setFmtBgColor] = useState('#ffff00');

  const sortedRules = rules
    ? Object.entries(rules).sort((a, b) => a[1].index - b[1].index)
    : [];

  const rangeToA1 = (rule: ConditionalFormatRule): string => {
    const rStart = sortedRowIds.indexOf(rule.rangeRowStart);
    const rEnd = sortedRowIds.indexOf(rule.rangeRowEnd);
    const cStart = sortedColIds.indexOf(rule.rangeColStart);
    const cEnd = sortedColIds.indexOf(rule.rangeColEnd);
    if (rStart === -1 || rEnd === -1 || cStart === -1 || cEnd === -1) return '?';
    return `${colIndexToLetter(cStart)}${rStart + 1}:${colIndexToLetter(cEnd)}${rEnd + 1}`;
  };

  const parseA1Range = (text: string): { rowStart: string; rowEnd: string; colStart: string; colEnd: string } | null => {
    const m = text.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
    if (!m) return null;
    const colStart = letterToColIndex(m[1].toUpperCase());
    const rowStart = parseInt(m[2], 10) - 1;
    const colEnd = letterToColIndex(m[3].toUpperCase());
    const rowEnd = parseInt(m[4], 10) - 1;
    if (rowStart < 0 || rowEnd < 0 || colStart < 0 || colEnd < 0) return null;
    if (rowStart >= sortedRowIds.length || rowEnd >= sortedRowIds.length) return null;
    if (colStart >= sortedColIds.length || colEnd >= sortedColIds.length) return null;
    return {
      rowStart: sortedRowIds[rowStart],
      rowEnd: sortedRowIds[rowEnd],
      colStart: sortedColIds[colStart],
      colEnd: sortedColIds[colEnd],
    };
  };

  const startEdit = (id: string) => {
    const rule = rules?.[id];
    if (!rule) return;
    setEditing(id);
    setRangeText(rangeToA1(rule));
    setConditionType(rule.conditionType);
    // For customFormula, convert internal format back to A1 for display
    if (rule.conditionType === 'customFormula' && rule.conditionValue) {
      const anchorRow = sortedRowIds.indexOf(rule.rangeRowStart);
      const anchorCol = sortedColIds.indexOf(rule.rangeColStart);
      setConditionValue(internalToA1(rule.conditionValue, anchorRow, anchorCol, sortedRowIds, sortedColIds));
    } else {
      setConditionValue(rule.conditionValue ?? '');
    }
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
    const parsed = parseA1Range(rangeText);
    if (!parsed) return;

    const format: DataGridCellFormat = {};
    if (fmtBold) format.bold = true;
    if (fmtItalic) format.italic = true;
    if (fmtTextColor !== '#000000') format.textColor = fmtTextColor;
    format.bgColor = fmtBgColor;

    // For customFormula, convert the A1 formula to internal format
    // anchored at the top-left of the range
    let storedCondValue: string | undefined;
    if (conditionType === 'customFormula' && conditionValue) {
      const anchorRow = sortedRowIds.indexOf(parsed.rowStart);
      const anchorCol = sortedColIds.indexOf(parsed.colStart);
      const formula = conditionValue.startsWith('=') ? conditionValue : '=' + conditionValue;
      storedCondValue = a1ToInternal(formula, anchorRow, anchorCol, sortedRowIds, sortedColIds);
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
        rangeRowStart: parsed.rowStart,
        rangeRowEnd: parsed.rowEnd,
        rangeColStart: parsed.colStart,
        rangeColEnd: parsed.colEnd,
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
        rangeRowStart: parsed.rowStart,
        rangeRowEnd: parsed.rowEnd,
        rangeColStart: parsed.colStart,
        rangeColEnd: parsed.colEnd,
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

  const condLabel = (type: string) =>
    CONDITION_TYPES.find(c => c.value === type)?.label ?? type;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[400px] sm:max-w-[400px]">
        <SheetHeader>
          <SheetTitle>Conditional Formatting</SheetTitle>
        </SheetHeader>

        <div className="mt-4 space-y-3">
          {editing ? (
            // Editor
            <div className="space-y-3">
              <div>
                <Label>Range (e.g. A1:C10)</Label>
                <Input
                  value={rangeText}
                  onInput={(e: any) => setRangeText(e.target.value)}
                  placeholder="A1:C10"
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
                    placeholder={conditionType === 'customFormula' ? '=ISFORMULA(A1)' : 'Enter value...'}
                    className="mt-1"
                  />
                  {conditionType === 'customFormula' && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Formula is evaluated relative to each cell in the range.
                    </p>
                  )}
                </div>
              )}
              <div>
                <Label>Formatting</Label>
                <div className="flex items-center gap-2 mt-1">
                  <Button
                    variant={fmtBold ? 'default' : 'outline'}
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setFmtBold(!fmtBold)}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: '1rem' }}>format_bold</span>
                  </Button>
                  <Button
                    variant={fmtItalic ? 'default' : 'outline'}
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
            // Rule list
            <>
              {sortedRules.length === 0 && (
                <p className="text-sm text-muted-foreground">No conditional formatting rules.</p>
              )}
              {sortedRules.map(([id, rule]) => (
                <div key={id} className="flex items-center justify-between border rounded-md p-2 text-sm">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{condLabel(rule.conditionType)}{rule.conditionValue ? ` ${rule.conditionValue}` : ''}</div>
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
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => startEdit(id)}>
                      <span className="material-symbols-outlined" style={{ fontSize: '1rem' }}>edit</span>
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => deleteRule(id)}>
                      <span className="material-symbols-outlined" style={{ fontSize: '1rem' }}>delete</span>
                    </Button>
                  </div>
                </div>
              ))}
              <Button onClick={startNew} size="sm" className="mt-2">
                <span className="material-symbols-outlined mr-1" style={{ fontSize: '1rem' }}>add</span>
                Add rule
              </Button>
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
