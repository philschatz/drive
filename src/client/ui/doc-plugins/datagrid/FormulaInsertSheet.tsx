import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';

/**
 * Curated HyperFormula built-ins shown alongside the custom functions in the
 * insert-formula sheet (the full HF list is hundreds of entries — these cover
 * the common cases; anything else can be typed with autocomplete).
 */
const BUILTIN_FN_NAMES = [
  'SUM', 'AVERAGE', 'COUNT', 'COUNTA', 'MIN', 'MAX', 'ROUND', 'ABS',
  'IF', 'AND', 'OR', 'NOT', 'IFERROR',
  'COUNTIF', 'SUMIF', 'AVERAGEIF',
  'VLOOKUP', 'HLOOKUP', 'INDEX', 'MATCH',
  'CONCATENATE', 'LEFT', 'RIGHT', 'MID', 'LEN', 'TRIM', 'LOWER', 'UPPER',
  'TODAY', 'NOW', 'DATE', 'YEAR', 'MONTH', 'DAY',
  'POWER', 'SQRT', 'EXP', 'LN', 'LOG10', 'MOD', 'FLOOR', 'CEILING',
  'MEDIAN', 'STDEV', 'VAR', 'RAND', 'RANDBETWEEN',
];

/**
 * Bottom sheet listing insertable formula functions. Custom (drive-specific)
 * functions come first, then the curated built-ins. Selecting one closes the
 * sheet first (so a follow-up focus lands in the editor, per the action-sheet
 * convention), then hands the name to `onInsert`.
 */
export function FormulaInsertSheet({
  open,
  onOpenChange,
  customFunctionNames,
  onInsert,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customFunctionNames: string[];
  onInsert: (name: string) => void;
}) {
  const pick = (name: string) => {
    onOpenChange(false);
    onInsert(name);
  };
  const custom = [...customFunctionNames].sort();
  const builtins = [...BUILTIN_FN_NAMES].sort();
  const item = (name: string) => (
    <md-list-item key={name} type="button" onClick={() => pick(name)}>
      <md-icon slot="start">function</md-icon>
      <div slot="headline" className="font-mono">{name}</div>
    </md-list-item>
  );
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[70vh] p-4">
        <SheetHeader>
          <SheetTitle>Insert function</SheetTitle>
        </SheetHeader>
        {/* SheetContent doesn't forward extra props — testid goes on the list */}
        <md-list style={{ background: 'transparent' }} className="mt-2" data-testid="formula-insert-sheet">
          {custom.map(item)}
          {custom.length > 0 && <md-divider role="separator" />}
          {builtins.map(item)}
        </md-list>
      </SheetContent>
    </Sheet>
  );
}
