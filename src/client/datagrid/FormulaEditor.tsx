import { useRef, useEffect, useCallback } from 'preact/hooks';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import { letterToColIndex } from './helpers';

// Rotating palette for cell/range reference colors (Google Sheets style)
const REF_COLORS = [
  '#f9ab00', // amber
  '#4285f4', // blue
  '#00acc1', // teal
  '#ea4335', // red
  '#9334e6', // purple
  '#34a853', // green
  '#fa7b17', // orange
  '#e91e8a', // pink
];

export interface FormulaRef {
  col: number;
  row: number;
  color: string;
}

export interface FormulaRangeRef {
  minCol: number;
  maxCol: number;
  minRow: number;
  maxRow: number;
  color: string;
}

export type FormulaHighlight = (FormulaRef | FormulaRangeRef) & { active?: boolean };

function isRange(h: FormulaHighlight): h is FormulaRangeRef & { active?: boolean } {
  return 'minCol' in h;
}

// Token types for A1 formula highlighting
interface FormulaToken {
  type: 'equals' | 'cellRef' | 'range' | 'function' | 'number' | 'string' | 'boolean' | 'operator' | 'paren' | 'error' | 'comma';
  start: number;
  end: number;
  refIndex?: number;
  /** True when the ref is prefixed with a sheet name (e.g. Sheet2!A1) */
  crossSheet?: boolean;
}

// Tokenize an A1-format formula for syntax highlighting purposes
function tokenizeA1(text: string): FormulaToken[] {
  const tokens: FormulaToken[] = [];
  if (!text.startsWith('=')) return tokens;
  tokens.push({ type: 'equals', start: 0, end: 1 });

  let i = 1;
  const len = text.length;
  let refCounter = 0;

  while (i < len) {
    if (text[i] === ' ' || text[i] === '\t') { i++; continue; }

    const start = i;
    const ch = text[i];

    // String literal
    if (ch === '"') {
      i++;
      while (i < len) {
        if (text[i] === '"') {
          if (i + 1 < len && text[i + 1] === '"') { i += 2; }
          else { i++; break; }
        } else { i++; }
      }
      tokens.push({ type: 'string', start, end: i });
      continue;
    }

    // Error literal
    if (ch === '#') {
      const rest = text.slice(i);
      const m = rest.match(/^#(?:N\/A|[A-Z/0]+[!?])/i);
      if (m) {
        tokens.push({ type: 'error', start, end: i + m[0].length });
        i += m[0].length;
        continue;
      }
      i++;
      continue;
    }

    // Number
    if ((ch >= '0' && ch <= '9') || (ch === '.' && i + 1 < len && text[i + 1] >= '0' && text[i + 1] <= '9')) {
      while (i < len && ((text[i] >= '0' && text[i] <= '9') || text[i] === '.')) i++;
      if (i < len && (text[i] === 'E' || text[i] === 'e')) {
        const saved = i;
        i++;
        if (i < len && (text[i] === '+' || text[i] === '-')) i++;
        if (i < len && text[i] >= '0' && text[i] <= '9') {
          while (i < len && text[i] >= '0' && text[i] <= '9') i++;
        } else {
          i = saved;
        }
      }
      tokens.push({ type: 'number', start, end: i });
      continue;
    }

    // Quoted sheet prefix: 'Sheet Name'!A1 or 'Sheet Name'!A1:B2
    if (ch === "'") {
      const rest = text.slice(i);
      // Match 'SheetName'! followed by a cell ref or range
      const quotedMatch = rest.match(/^'(?:[^']|'')*'!(\$?[A-Za-z]+\$?\d+)(?::(\$?[A-Za-z]+\$?\d+))?/);
      if (quotedMatch) {
        const refIdx = refCounter++;
        if (quotedMatch[2]) {
          tokens.push({ type: 'range', start: i, end: i + quotedMatch[0].length, refIndex: refIdx, crossSheet: true });
        } else {
          tokens.push({ type: 'cellRef', start: i, end: i + quotedMatch[0].length, refIndex: refIdx, crossSheet: true });
        }
        i += quotedMatch[0].length;
        continue;
      }
      // Also match quoted sheet prefix with column range: 'Sheet'!B:B
      const quotedColRange = rest.match(/^'(?:[^']|'')*'!\$?[A-Za-z]+:\$?[A-Za-z]+/);
      if (quotedColRange) {
        tokens.push({ type: 'range', start: i, end: i + quotedColRange[0].length, refIndex: refCounter++, crossSheet: true });
        i += quotedColRange[0].length;
        continue;
      }
      // Also match quoted sheet prefix with row range: 'Sheet'!1:5
      const quotedRowRange = rest.match(/^'(?:[^']|'')*'!\$?\d+:\$?\d+/);
      if (quotedRowRange) {
        tokens.push({ type: 'range', start: i, end: i + quotedRowRange[0].length, refIndex: refCounter++, crossSheet: true });
        i += quotedRowRange[0].length;
        continue;
      }
      i++;
      continue;
    }

    // Dollar sign or letter: could be cell ref, range, boolean, or function
    if (ch === '$' || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) {
      const rest = text.slice(i);

      // Unquoted sheet prefix: SheetName!A1 or SheetName!A1:B2
      const sheetCellMatch = rest.match(/^([A-Za-z0-9_]+)!(\$?[A-Za-z]+\$?\d+)(?::(\$?[A-Za-z]+\$?\d+))?/);
      if (sheetCellMatch) {
        const name = sheetCellMatch[1].toUpperCase();
        if (name !== 'TRUE' && name !== 'FALSE') {
          const refIdx = refCounter++;
          if (sheetCellMatch[3]) {
            tokens.push({ type: 'range', start: i, end: i + sheetCellMatch[0].length, refIndex: refIdx, crossSheet: true });
          } else {
            tokens.push({ type: 'cellRef', start: i, end: i + sheetCellMatch[0].length, refIndex: refIdx, crossSheet: true });
          }
          i += sheetCellMatch[0].length;
          continue;
        }
      }
      // Unquoted sheet prefix with column range: SheetName!B:B
      const sheetColRange = rest.match(/^([A-Za-z0-9_]+)!\$?[A-Za-z]+:\$?[A-Za-z]+/);
      if (sheetColRange) {
        const name = sheetColRange[1].toUpperCase();
        if (name !== 'TRUE' && name !== 'FALSE') {
          tokens.push({ type: 'range', start: i, end: i + sheetColRange[0].length, refIndex: refCounter++, crossSheet: true });
          i += sheetColRange[0].length;
          continue;
        }
      }
      // Unquoted sheet prefix with row range: SheetName!1:5
      const sheetRowRange = rest.match(/^([A-Za-z0-9_]+)!\$?\d+:\$?\d+/);
      if (sheetRowRange) {
        const name = sheetRowRange[1].toUpperCase();
        if (name !== 'TRUE' && name !== 'FALSE') {
          tokens.push({ type: 'range', start: i, end: i + sheetRowRange[0].length, refIndex: refCounter++, crossSheet: true });
          i += sheetRowRange[0].length;
          continue;
        }
      }

      const cellMatch = rest.match(/^(\$?[A-Za-z]+\$?\d+)(?::(\$?[A-Za-z]+\$?\d+))?/);
      if (cellMatch) {
        const firstRef = cellMatch[1];
        const lettersMatch = firstRef.match(/^\$?([A-Za-z]+)\$?\d+$/);
        if (lettersMatch) {
          const letters = lettersMatch[1].toUpperCase();
          if (letters !== 'TRUE' && letters !== 'FALSE') {
            const pureLetters = rest.match(/^[A-Za-z]+/);
            if (pureLetters && text[i + pureLetters[0].length] === '(' && !cellMatch[1].match(/\d/)) {
              // function name, fall through
            } else {
              const colIdx = letterToColIndex(letters);
              if (colIdx >= 0 && colIdx < 18278) {
                if (cellMatch[2]) {
                  tokens.push({ type: 'range', start: i, end: i + cellMatch[0].length, refIndex: refCounter++ });
                } else {
                  tokens.push({ type: 'cellRef', start: i, end: i + cellMatch[0].length, refIndex: refCounter++ });
                }
                i += cellMatch[0].length;
                continue;
              }
            }
          }
        }
      }

      const boolMatch = rest.match(/^(TRUE|FALSE)(?![A-Za-z(])/i);
      if (boolMatch) {
        tokens.push({ type: 'boolean', start, end: i + boolMatch[0].length });
        i += boolMatch[0].length;
        continue;
      }

      const funcMatch = rest.match(/^[A-Za-z]+(?=\s*\()/);
      if (funcMatch) {
        tokens.push({ type: 'function', start, end: i + funcMatch[0].length });
        i += funcMatch[0].length;
        continue;
      }

      i++;
      continue;
    }

    // Operators
    if ('+-*/^&=<>'.includes(ch)) {
      if (ch === '<' && i + 1 < len && (text[i + 1] === '>' || text[i + 1] === '=')) {
        tokens.push({ type: 'operator', start, end: i + 2 }); i += 2; continue;
      }
      if (ch === '>' && i + 1 < len && text[i + 1] === '=') {
        tokens.push({ type: 'operator', start, end: i + 2 }); i += 2; continue;
      }
      tokens.push({ type: 'operator', start, end: i + 1 }); i++; continue;
    }

    if (ch === '(' || ch === ')') { tokens.push({ type: 'paren', start, end: i + 1 }); i++; continue; }
    if (ch === ',') { tokens.push({ type: 'comma', start, end: i + 1 }); i++; continue; }
    i++;
  }

  return tokens;
}

// Parse a cell reference string like "$A$1" or "B2" into grid coordinates
function parseCellRefStr(ref: string): { col: number; row: number } | null {
  const m = ref.match(/^\$?([A-Za-z]+)\$?(\d+)$/);
  if (!m) return null;
  const col = letterToColIndex(m[1].toUpperCase());
  const row = parseInt(m[2], 10) - 1;
  if (col < 0 || row < 0) return null;
  return { col, row };
}

// Extract FormulaHighlights from A1 text, marking the ref under the cursor as active
function extractHighlights(text: string, cursorPos?: number): FormulaHighlight[] {
  if (!text.startsWith('=')) return [];
  const tokens = tokenizeA1(text);
  const highlights: FormulaHighlight[] = [];

  let activeRefIndex: number | null = null;
  if (cursorPos != null) {
    for (const tok of tokens) {
      if ((tok.type === 'cellRef' || tok.type === 'range') && tok.refIndex != null) {
        if (cursorPos >= tok.start && cursorPos <= tok.end) {
          activeRefIndex = tok.refIndex;
          break;
        }
      }
    }
  }

  for (const tok of tokens) {
    // Cross-sheet refs get syntax highlighting but should not produce cell highlights
    if (tok.crossSheet) continue;
    const active = tok.refIndex != null && tok.refIndex === activeRefIndex;
    if (tok.type === 'cellRef') {
      const ref = parseCellRefStr(text.slice(tok.start, tok.end));
      if (ref) {
        highlights.push({ col: ref.col, row: ref.row, color: REF_COLORS[tok.refIndex! % REF_COLORS.length], active });
      }
    } else if (tok.type === 'range') {
      const parts = text.slice(tok.start, tok.end).split(':');
      if (parts.length === 2) {
        const from = parseCellRefStr(parts[0]);
        const to = parseCellRefStr(parts[1]);
        if (from && to) {
          highlights.push({
            minCol: Math.min(from.col, to.col),
            maxCol: Math.max(from.col, to.col),
            minRow: Math.min(from.row, to.row),
            maxRow: Math.max(from.row, to.row),
            color: REF_COLORS[tok.refIndex! % REF_COLORS.length],
            active,
          });
        }
      }
    }
  }

  return highlights;
}

// Token type → CSS class
const tokenClassMap: Record<FormulaToken['type'], string> = {
  equals: 'formula-tok-equals',
  cellRef: 'formula-tok-ref',
  range: 'formula-tok-ref',
  function: 'formula-tok-function',
  number: 'formula-tok-number',
  string: 'formula-tok-string',
  boolean: 'formula-tok-boolean',
  operator: 'formula-tok-operator',
  paren: 'formula-tok-paren',
  error: 'formula-tok-error',
  comma: 'formula-tok-operator',
};

/** Find the span of the innermost function call enclosing the cursor.
 *  Returns { start, end } covering FUNCNAME(...) or null if cursor is
 *  not inside any function call. */
function findEnclosingFunctionSpan(
  text: string,
  tokens: FormulaToken[],
  cursor: number,
): { start: number; end: number } | null {
  const spans: { start: number; end: number }[] = [];

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'function') continue;
    const funcStart = tokens[i].start;
    // Find the opening paren
    let j = i + 1;
    while (j < tokens.length && tokens[j].type !== 'paren') j++;
    if (j >= tokens.length || text[tokens[j].start] !== '(') continue;
    // Find the matching close paren
    let depth = 1;
    let k = j + 1;
    while (k < tokens.length && depth > 0) {
      if (tokens[k].type === 'paren') {
        if (text[tokens[k].start] === '(') depth++;
        else if (text[tokens[k].start] === ')') depth--;
      }
      k++;
    }
    if (depth === 0) {
      spans.push({ start: funcStart, end: tokens[k - 1].end });
    }
  }

  // Find the innermost (smallest) span containing the cursor
  let best: { start: number; end: number } | null = null;
  for (const span of spans) {
    if (cursor >= span.start && cursor <= span.end) {
      if (!best || (span.end - span.start) < (best.end - best.start)) {
        best = span;
      }
    }
  }
  return best;
}

interface FormulaEditorProps {
  value: string;
  onInput: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onBlur: () => void;
  onFocus?: () => void;
  onTab?: () => void;
  onHighlightsChange?: (highlights: FormulaHighlight[]) => void;
  functionNames: string[];
  autoFocus?: boolean;
  className?: string;
}

export function FormulaEditor({
  value,
  onInput,
  onCommit,
  onCancel,
  onBlur,
  onFocus,
  onTab,
  onHighlightsChange,
  functionNames,
  autoFocus,
  className,
}: FormulaEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const focusedRef = useRef(false);
  const callbacksRef = useRef({ onInput, onCommit, onCancel, onBlur, onFocus, onTab, onHighlightsChange });
  callbacksRef.current = { onInput, onCommit, onCancel, onBlur, onFocus, onTab, onHighlightsChange };

  const lastExternalValue = useRef(value);

  const emitHighlights = useCallback((text: string, cursorPos?: number) => {
    const highlights = extractHighlights(text, cursorPos);
    callbacksRef.current.onHighlightsChange?.(highlights);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let view: EditorView | null = null;
    let cancelled = false;

    // Lazy-load all CodeMirror modules — they don't ship with the initial bundle
    // and are only fetched when an editor is first mounted. This keeps the initial
    // page-load heap much smaller and prevents the Chromium renderer OOM.
    Promise.all([
      import('@codemirror/view'),
      import('@codemirror/state'),
      import('@codemirror/autocomplete'),
    ]).then(([cmView, cmState, cmAuto]) => {
      if (cancelled || !el.isConnected) return;

      const { EditorView, Decoration, ViewPlugin, keymap } = cmView;
      const { EditorState, RangeSetBuilder, Prec } = cmState;
      const { autocompletion, completionStatus } = cmAuto;

      // Syntax highlighting plugin — dims tokens outside the innermost
      // enclosing function call so the user can focus on the active context.
      const dimMark = Decoration.mark({ attributes: { style: 'color: #999;' } });
      const formulaHighlighter = ViewPlugin.fromClass(class {
        decorations: any;
        constructor(v: any) { this.decorations = this.build(v); }
        update(u: any) { if (u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = this.build(u.view); }
        build(v: any) {
          const builder = new RangeSetBuilder<any>();
          const text = v.state.doc.toString();
          if (!text.startsWith('=')) return builder.finish();
          const tokens = tokenizeA1(text);
          const cursor = v.state.selection.main.head;
          const activeSpan = findEnclosingFunctionSpan(text, tokens, cursor);

          if (!activeSpan) {
            // Cursor not inside any function call — normal coloring for everything
            for (const tok of tokens) {
              if (tok.type === 'cellRef' || tok.type === 'range') {
                const color = REF_COLORS[tok.refIndex! % REF_COLORS.length];
                builder.add(tok.start, tok.end, Decoration.mark({ class: tokenClassMap[tok.type], attributes: { style: `color: ${color}; font-weight: 600;` } }));
              } else {
                builder.add(tok.start, tok.end, Decoration.mark({ class: tokenClassMap[tok.type] }));
              }
            }
          } else {
            // Dim region before the active function span
            if (activeSpan.start > 0) {
              builder.add(0, activeSpan.start, dimMark);
            }
            // Normal decorations for tokens inside the active span
            for (const tok of tokens) {
              if (tok.start < activeSpan.start || tok.end > activeSpan.end) continue;
              if (tok.type === 'cellRef' || tok.type === 'range') {
                const color = REF_COLORS[tok.refIndex! % REF_COLORS.length];
                builder.add(tok.start, tok.end, Decoration.mark({ class: tokenClassMap[tok.type], attributes: { style: `color: ${color}; font-weight: 600;` } }));
              } else {
                builder.add(tok.start, tok.end, Decoration.mark({ class: tokenClassMap[tok.type] }));
              }
            }
            // Dim region after the active function span
            if (activeSpan.end < text.length) {
              builder.add(activeSpan.end, text.length, dimMark);
            }
          }
          return builder.finish();
        }
      }, { decorations: (v: any) => v.decorations });

      // Autocomplete source
      const completionSource = (context: any) => {
        const text = context.state.doc.toString();
        if (!text.startsWith('=')) return null;
        const word = context.matchBefore(/[A-Za-z]+/);
        if (!word || word.from === word.to) return null;
        if (word.from > 0 && text[word.from - 1] === '$') return null;
        const after = text[word.to];
        if (after && after >= '0' && after <= '9') return null;
        const prefix = word.text.toUpperCase();
        const options = functionNames.filter(n => n.startsWith(prefix)).map(n => ({
          label: n, type: 'function', apply: n + '(', boost: n === prefix ? 10 : 0,
        }));
        return options.length ? { from: word.from, options, validFor: /^[A-Za-z]*$/ } : null;
      };

      const updateListener = EditorView.updateListener.of((update: ViewUpdate) => {
        const cursor = update.state.selection.main.head;
        if (update.docChanged) {
          const text = update.state.doc.toString();
          lastExternalValue.current = text;
          callbacksRef.current.onInput(text);
          emitHighlights(text, cursor);
        } else if (update.selectionSet) {
          emitHighlights(update.state.doc.toString(), cursor);
        }
      });

      const commitKeymap = Prec.highest(keymap.of([
        // Only defer to CodeMirror when the autocomplete dropdown is fully visible
        // ("active"). The "pending" state means the source is still computing but
        // no dropdown is shown yet — commit/cancel normally in that case so that
        // slow completion sources (e.g. under coverage instrumentation) don't drop
        // Enter/Escape/Tab presses.
        { key: 'Enter', run: (view) => { if (completionStatus(view.state) === 'active') return false; callbacksRef.current.onCommit(); return true; } },
        { key: 'Escape', run: (view) => { if (completionStatus(view.state) === 'active') return false; callbacksRef.current.onCancel(); return true; } },
        { key: 'Tab', run: (view) => { if (completionStatus(view.state) === 'active') return false; if (callbacksRef.current.onTab) { callbacksRef.current.onTab(); return true; } return false; } },
      ]));

      const eventHandlers = EditorView.domEventHandlers({
        focus() { focusedRef.current = true; callbacksRef.current.onFocus?.(); },
        blur() { focusedRef.current = false; callbacksRef.current.onBlur(); },
      });

      const state = EditorState.create({
        doc: lastExternalValue.current,
        extensions: [
          commitKeymap,
          formulaHighlighter,
          autocompletion({ override: [completionSource], activateOnTyping: true, icons: false }),
          updateListener,
          eventHandlers,
          EditorView.theme({
            '&': { fontSize: '0.85rem', fontFamily: 'monospace', background: 'transparent' },
            '.cm-content': { padding: '2px 0', caretColor: '#000' },
            '&.cm-focused': { outline: 'none' },
            '.cm-line': { padding: '0' },
            '.cm-scroller': { overflowX: 'auto', overflowY: 'hidden' },
            '.cm-tooltip.cm-tooltip-autocomplete': { border: '1px solid #dee2e6', borderRadius: '4px', boxShadow: '0 4px 12px rgba(0,0,0,0.15)', fontSize: '0.8rem', fontFamily: 'monospace' },
            '.cm-tooltip.cm-tooltip-autocomplete ul li': { padding: '3px 8px' },
            '.cm-tooltip.cm-tooltip-autocomplete ul li[aria-selected]': { background: '#228be6', color: '#fff' },
            '.cm-completionLabel': { fontFamily: 'monospace' },
          }),
        ],
      });

      view = new EditorView({ state, parent: el });
      viewRef.current = view;
      emitHighlights(lastExternalValue.current);

      if (autoFocus) {
        view.focus();
        view.dispatch({ selection: { anchor: lastExternalValue.current.length } });
      }
    });

    return () => {
      cancelled = true;
      view?.destroy();
      viewRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [functionNames]);

  // Sync external value changes — skip while focused (editor is authoritative).
  // Always update lastExternalValue so the CM view gets the right doc when it
  // loads asynchronously (e.g. formula bar mounts before CodeMirror resolves).
  useEffect(() => {
    lastExternalValue.current = value;
    const view = viewRef.current;
    if (!view) return;
    if (focusedRef.current) return;
    const currentText = view.state.doc.toString();
    if (currentText !== value) {
      view.dispatch({ changes: { from: 0, to: currentText.length, insert: value } });
      emitHighlights(value);
    }
  }, [value, emitHighlights]);

  return <div ref={containerRef} className={className ?? 'formula-editor-cm'} />;
}


export { extractHighlights, REF_COLORS, tokenizeA1, parseCellRefStr, isRange };
