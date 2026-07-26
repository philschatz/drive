import { useRef, useState } from 'preact/hooks';
import { FormulaEditor, type FormulaEditorApi, type FormulaHighlight } from './FormulaEditor';
import type { ResolvedEntry } from './commands';
import { useKeyboardInset } from '../shared/useKeyboardInset';

/** Characters that are awkward to reach on mobile keyboards — shown as an
 * insert strip while the formula editor is focused. */
const FORMULA_CHARS = ['=', '(', ')', ':', '-', '/', '*', ',', '+', '$'];

/** Pre-formatted aggregate chip (e.g. `{ label: 'Sum', value: '$30.00' }`). */
export interface AggregateChip {
  label: string;
  value: string;
}

function QuickActionButton({
  entry,
  overrideIcon,
}: {
  entry: ResolvedEntry & { kind: 'command' };
  overrideIcon?: string;
}) {
  return (
    <button
      aria-label={entry.label}
      title={entry.label}
      disabled={!entry.isEnabled}
      onClick={entry.execute}
      className={
        'inline-flex items-center justify-center h-10 w-10 rounded-full state-layer shrink-0 disabled:opacity-30' +
        (entry.isChecked ? ' bg-secondary-container text-on-secondary-container' : '')
      }
    >
      <span className="material-symbols-outlined" style={{ fontSize: 22 }}>{overrideIcon ?? entry.icon}</span>
    </button>
  );
}

/**
 * Focus-mode bottom bar: the (single) cell editor on top, and below it either
 * the quick formatting actions or — while the editor is focused — a strip of
 * formula characters that are hard to reach on mobile keyboards. Rides above
 * the on-screen keyboard via the visualViewport inset (iOS; Android resizes
 * the layout viewport instead).
 */
export function BottomEditorBar({
  value,
  onInput,
  onEditorFocus,
  onCommit,
  onCancel,
  onTab,
  onBlur,
  onHighlightsChange,
  functionNames,
  readOnly,
  apiRef,
  previewValue,
  resolveCommand,
  onOpenFormat,
  onInsertFormula,
  aggregates,
  multiSelect,
}: {
  value: string;
  onInput: (v: string) => void;
  /** Focusing the editor starts editing the selected cell. */
  onEditorFocus: () => void;
  onCommit: () => void;
  onCancel: () => void;
  onTab: () => void;
  /** Blur-commit with the caller's activeElement guard. */
  onBlur: () => void;
  onHighlightsChange: (highlights: FormulaHighlight[]) => void;
  functionNames: string[];
  readOnly: boolean;
  apiRef: { current: FormulaEditorApi | null };
  /** Cached computed value of the formula being edited (preview overlay). */
  previewValue?: string;
  /** Resolve a command id into an executable entry (from useGridCommands). */
  resolveCommand: (id: string) => ResolvedEntry & { kind: 'command' };
  /** Open the text-formatting sheet (absent while it isn't wired up). */
  onOpenFormat?: () => void;
  onInsertFormula: () => void;
  aggregates: AggregateChip[] | null;
  /** Multi-cell selection: the (single-cell) editor is hidden — row 1 shows
   * the aggregates instead (or collapses when there's nothing numeric). */
  multiSelect: boolean;
}) {
  const [formulaFocused, setFormulaFocused] = useState(false);
  const alignBtnRef = useRef<HTMLButtonElement>(null);
  const alignMenuRef = useRef<any>(null);
  const inset = useKeyboardInset();

  const align = resolveCommand(
    ['align-left', 'align-center', 'align-right'].find(id => resolveCommand(id).isChecked) ?? 'align-left',
  );

  return (
    <div
      className="bottom-editor-bar shrink-0 bg-surface-container-low border-t border-outline-variant relative"
      style={{
        transform: inset ? `translateY(-${inset}px)` : undefined,
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
      data-testid="bottom-editor-bar"
    >
      {/* Row 1 — the cell editor; hidden for multi-cell selections (nothing
          single-cell to edit), where the numeric aggregates show instead. */}
      {multiSelect ? (aggregates && aggregates.length > 0 && (
        <div
          className="flex items-center gap-3 px-3 overflow-x-auto min-h-12"
          data-testid="aggregates-strip"
        >
          {aggregates.map(chip => (
            <span key={chip.label} className="md-label-large whitespace-nowrap text-on-surface-variant">
              {chip.label}: <span className="font-mono text-on-surface">{chip.value}</span>
            </span>
          ))}
        </div>
      )) : (
      <div className="flex items-center gap-1 px-2 py-1 relative">
        {previewValue != null && (
          <div className="cell-eval-tooltip" style={{ top: 'auto', bottom: '100%', marginBottom: 2 }}>
            {previewValue}
          </div>
        )}
        <button
          aria-label="Insert function"
          title="Insert function"
          disabled={readOnly}
          className="inline-flex items-center justify-center h-10 w-10 rounded-full state-layer shrink-0 disabled:opacity-30"
          onClick={onInsertFormula}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 22 }}>function</span>
        </button>
        <FormulaEditor
          className="bottom-editor-cm"
          value={value}
          onInput={onInput}
          onFocus={() => { setFormulaFocused(true); onEditorFocus(); }}
          onBlur={() => { setFormulaFocused(false); onBlur(); }}
          onCommit={onCommit}
          onCancel={onCancel}
          onTab={onTab}
          onHighlightsChange={onHighlightsChange}
          functionNames={functionNames}
          readOnly={readOnly}
          autoFocus={false}
          placeholder="Enter text or formula"
          apiRef={apiRef}
        />
      </div>
      )}

      {/* Row 2 — formula char strip while the editor is focused, quick actions otherwise */}
      {formulaFocused && !readOnly ? (
        <div className="flex items-stretch overflow-x-auto border-t border-outline-variant" data-testid="formula-char-strip">
          {FORMULA_CHARS.map(ch => (
            <button
              key={ch}
              aria-label={`Insert ${ch}`}
              className="flex-1 min-w-9 h-10 state-layer font-mono md-body-large text-on-surface"
              // preventDefault keeps focus (and the on-screen keyboard) in the editor
              onPointerDown={(e: any) => e.preventDefault()}
              onMouseDown={(e: any) => e.preventDefault()}
              onClick={() => apiRef.current?.insertText(ch)}
            >
              {ch}
            </button>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-0.5 px-1 overflow-x-auto border-t border-outline-variant" data-testid="quick-actions-row">
          <QuickActionButton entry={resolveCommand('toggle-bold')} />
          <QuickActionButton entry={resolveCommand('toggle-strikethrough')} />
          {onOpenFormat && (
            <button
              aria-label="Text color"
              title="Text color"
              className="inline-flex items-center justify-center h-10 w-10 rounded-full state-layer shrink-0"
              onClick={onOpenFormat}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 22 }}>format_color_text</span>
            </button>
          )}
          {/* Alignment dropdown — shows the current alignment's icon */}
          <button
            ref={alignBtnRef}
            aria-label="Alignment"
            title="Alignment"
            disabled={!align.isEnabled}
            className="inline-flex items-center justify-center h-10 w-10 rounded-full state-layer shrink-0 disabled:opacity-30"
            onClick={() => {
              const menu = alignMenuRef.current;
              if (!menu) return;
              menu.anchorElement = alignBtnRef.current;
              menu.open = !menu.open;
            }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 22 }}>{align.icon}</span>
          </button>
          <md-menu ref={alignMenuRef} anchor-corner="start-start" menu-corner="end-start">
            {['align-left', 'align-center', 'align-right'].map(id => {
              const entry = resolveCommand(id);
              return (
                <md-menu-item key={id} disabled={!entry.isEnabled || undefined} onClick={entry.execute}>
                  <md-icon slot="start" className={entry.isChecked ? 'icon-filled' : undefined}>{entry.icon}</md-icon>
                  <div slot="headline">{entry.label}</div>
                </md-menu-item>
              );
            })}
          </md-menu>
          {onOpenFormat && (
            <button
              aria-label="Fill color"
              title="Fill color"
              className="inline-flex items-center justify-center h-10 w-10 rounded-full state-layer shrink-0"
              onClick={onOpenFormat}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 22 }}>format_color_fill</span>
            </button>
          )}
          <QuickActionButton entry={resolveCommand('insert-row-below')} overrideIcon="add_row_below" />
          <QuickActionButton entry={resolveCommand('insert-col-right')} overrideIcon="add_column_right" />
        </div>
      )}
    </div>
  );
}
