import { useRef, useEffect, useCallback } from 'preact/hooks';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import { isRange, tokenizeA1, extractHighlights, tokenClassMap, findEnclosingFunctionSpan, REF_COLORS } from './formula-highlight';
import type { FormulaHighlight } from './formula-highlight';

/** Imperative surface for the editor. CodeMirror loads lazily, so calls made
 * before the view exists are buffered and replayed once it mounts. */
export interface FormulaEditorApi {
  /** Insert text at the cursor (replacing any selection) and keep focus. */
  insertText(text: string): void;
  /** Focus the editor with the cursor at the end of the content. */
  focus(): void;
  hasFocus(): boolean;
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
  /** Display-only: the formula stays visible (with highlighting) but CodeMirror
   * rejects edits. Used by the formula bar on read-only grids. */
  readOnly?: boolean;
  className?: string;
  /** Shown while the editor is empty (CodeMirror placeholder extension). */
  placeholder?: string;
  /** Receives the imperative API while mounted (null after unmount). */
  apiRef?: { current: FormulaEditorApi | null };
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
  readOnly,
  className,
  placeholder,
  apiRef,
}: FormulaEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const focusedRef = useRef(false);
  // Ops issued before the lazy-loaded view exists; replayed on mount.
  const pendingOpsRef = useRef<((view: EditorView) => void)[]>([]);
  const callbacksRef = useRef({ onInput, onCommit, onCancel, onBlur, onFocus, onTab, onHighlightsChange });
  callbacksRef.current = { onInput, onCommit, onCancel, onBlur, onFocus, onTab, onHighlightsChange };

  const lastExternalValue = useRef(value);

  const emitHighlights = useCallback((text: string, cursorPos?: number) => {
    const highlights = extractHighlights(text, cursorPos);
    callbacksRef.current.onHighlightsChange?.(highlights);
  }, []);

  // Imperative API — buffers ops until the lazy-loaded view is ready.
  const runOrQueue = useCallback((op: (view: EditorView) => void) => {
    const view = viewRef.current;
    if (view) op(view);
    else pendingOpsRef.current.push(op);
  }, []);

  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      insertText: (text) => runOrQueue(view => {
        view.dispatch(view.state.replaceSelection(text));
        view.focus();
      }),
      focus: () => runOrQueue(view => {
        view.focus();
        view.dispatch({ selection: { anchor: view.state.doc.length } });
      }),
      hasFocus: () => focusedRef.current,
    };
    return () => { apiRef.current = null; };
  }, [apiRef, runOrQueue]);

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
          ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
          ...(placeholder ? [cmView.placeholder(placeholder)] : []),
          commitKeymap,
          formulaHighlighter,
          autocompletion({ override: [completionSource], activateOnTyping: true, icons: false }),
          updateListener,
          eventHandlers,
          EditorView.theme({
            '&': { fontSize: '0.85rem', fontFamily: 'monospace', background: 'transparent' },
            '.cm-content': { padding: '2px 0', caretColor: 'var(--md-sys-color-on-surface)' },
            '&.cm-focused': { outline: 'none' },
            '.cm-line': { padding: '0' },
            '.cm-scroller': { overflowX: 'auto', overflowY: 'hidden' },
            '.cm-placeholder': { color: 'var(--md-sys-color-on-surface-variant)' },
            '.cm-tooltip.cm-tooltip-autocomplete': { border: '1px solid var(--md-sys-color-outline-variant)', borderRadius: '4px', boxShadow: 'var(--elevation-2)', fontSize: '0.8rem', fontFamily: 'monospace', background: 'var(--md-sys-color-surface)' },
            '.cm-tooltip.cm-tooltip-autocomplete ul li': { padding: '3px 8px' },
            '.cm-tooltip.cm-tooltip-autocomplete ul li[aria-selected]': { background: 'var(--md-sys-color-primary)', color: 'var(--md-sys-color-on-primary)' },
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

      // Replay imperative API calls made while CodeMirror was still loading.
      for (const op of pendingOpsRef.current.splice(0)) op(view);
    });

    return () => {
      cancelled = true;
      view?.destroy();
      viewRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [functionNames, readOnly, placeholder]);

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

export { isRange };
export type { FormulaHighlight };
