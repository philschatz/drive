import { useState, useRef, useEffect, useCallback } from 'preact/hooks';
import { run, JqError } from '../../shared/jq';

const JQ_BUILTINS = [
  'length', 'keys', 'values', 'has', 'type', 'not', 'empty',
  'map', 'select', 'sort_by', 'group_by', 'min_by', 'max_by',
  'to_entries', 'from_entries', 'flatten', 'add', 'any', 'all',
  'unique', 'first', 'last', 'limit', 'range',
  'ascii_downcase', 'ascii_upcase', 'ltrimstr', 'rtrimstr',
  'split', 'join', 'test', 'match', 'capture',
  'contains', 'inside', 'startswith', 'endswith',
  'null', 'true', 'false', 'if', 'then', 'elif', 'else', 'end',
  'and', 'or', 'not', 'debug', 'error', 'env', 'input',
  'recurse', 'recurse_down', 'tostring', 'tonumber',
  'ascii', 'explode', 'implode', 'tojson', 'fromjson',
  'infinite', 'nan', 'isinfinite', 'isnan', 'isnormal',
  'floor', 'ceil', 'round', 'fabs', 'sqrt', 'pow', 'log', 'exp',
  'indices', 'index', 'rindex', 'IN', 'del', 'getpath', 'setpath',
  'leaf_paths', 'path', 'paths', 'transpose', 'input', 'inputs',
  'with_entries', 'with_entries', 'reduce', 'foreach', 'label', 'break',
];

function defaultQuery(docType?: string): string {
  switch (docType) {
    case 'Calendar': return '.events | length';
    case 'DataGrid': return '[.sheets[].cells | length] | add';
    case 'TaskList': return '[.tasks[] | select(.progress != "completed")] | length';
    default: return '.';
  }
}

export function JqPanel({ data, docType }: { data: any; docType?: string }) {
  const [query, setQuery] = useState(() => defaultQuery(docType));
  const [result, setResult] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<any>(null);

  const executeQuery = useCallback((q: string) => {
    try {
      const res = run(q, data);
      setResult(res.map(v => JSON.stringify(v, null, 2)).join('\n'));
      setError(null);
    } catch (e: any) {
      setError(e instanceof JqError ? e.message : String(e));
      setResult('');
    }
  }, [data]);

  // Initialize CodeMirror once the container is mounted
  useEffect(() => {
    if (!containerRef.current || viewRef.current) return;

    let cancelled = false;

    Promise.all([
      import('@codemirror/view'),
      import('@codemirror/state'),
      import('@codemirror/autocomplete'),
    ]).then(([cmView, cmState, cmAuto]) => {
      if (cancelled || !containerRef.current) return;

      const { EditorView, keymap, Decoration, ViewPlugin } = cmView;
      const { EditorState, RangeSetBuilder } = cmState;
      // jq syntax highlighting via decorations
      const operatorDeco = Decoration.mark({ attributes: { style: 'color: #d4d4d4;' } });
      const bracketDeco = Decoration.mark({ attributes: { style: 'color: #888;' } });
      const stringDeco = Decoration.mark({ attributes: { style: 'color: #ce9178;' } });
      const builtinDeco = Decoration.mark({ attributes: { style: 'color: #dcdcaa;' } });

      const jqHighlighter = ViewPlugin.fromClass(class {
        decorations: any;
        constructor(v: any) { this.decorations = this.build(v); }
        update(u: any) { if (u.docChanged) this.decorations = this.build(u.view); }
        build(v: any) {
          const text = v.state.doc.toString();
          // Collect all spans, then sort by position for RangeSetBuilder
          const spans: [number, number, any][] = [];
          for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (ch === '.' || ch === '|' || ch === ',' || ch === ';') {
              spans.push([i, i + 1, operatorDeco]);
            } else if ('()[]{}' .includes(ch)) {
              spans.push([i, i + 1, bracketDeco]);
            } else if (ch === '"') {
              const end = text.indexOf('"', i + 1);
              if (end > i) { spans.push([i, end + 1, stringDeco]); i = end; }
            }
          }
          const wordRe = /\b([a-z_][a-z_0-9]*)\b/gi;
          let m;
          while ((m = wordRe.exec(text)) !== null) {
            if (JQ_BUILTINS.includes(m[1])) {
              spans.push([m.index, m.index + m[1].length, builtinDeco]);
            }
          }
          spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
          const builder = new RangeSetBuilder<any>();
          for (const [from, to, deco] of spans) builder.add(from, to, deco);
          return builder.finish();
        }
      }, { decorations: (v: any) => v.decorations });

      // Autocomplete jq builtins + top-level keys from the document
      const jqCompletion = cmAuto.autocompletion({
        override: [(context: any) => {
          const word = context.matchBefore(/[a-zA-Z_][a-zA-Z_0-9]*/);
          if (!word && !context.explicit) return null;
          const options: any[] = JQ_BUILTINS.map(b => ({ label: b, type: 'function' }));
          // Add top-level document keys as field completions
          if (data && typeof data === 'object' && !Array.isArray(data)) {
            for (const key of Object.keys(data)) {
              options.push({ label: '.' + key, type: 'property', boost: 1 });
            }
          }
          return {
            from: word ? word.from : context.pos,
            options,
            validFor: /^[a-zA-Z_.]*$/,
          };
        }],
      });

      const theme = EditorView.theme({
        '&': {
          backgroundColor: '#1e1e1e',
          color: '#9cdcfe',
          fontSize: '0.85rem',
          fontFamily: "'SF Mono', 'Consolas', 'Menlo', monospace",
        },
        '.cm-content': { padding: '4px 0', caretColor: '#d4d4d4' },
        '.cm-line': { padding: '0 4px' },
        '&.cm-focused .cm-cursor': { borderLeftColor: '#d4d4d4' },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
          backgroundColor: '#264f78 !important',
        },
        '.cm-tooltip.cm-tooltip-autocomplete': {
          backgroundColor: '#252526',
          border: '1px solid #454545',
          color: '#d4d4d4',
          fontFamily: "'SF Mono', 'Consolas', 'Menlo', monospace",
          fontSize: '0.8rem',
        },
        '.cm-tooltip-autocomplete ul li[aria-selected]': {
          backgroundColor: '#04395e',
        },
        '.cm-completionLabel': { color: '#d4d4d4' },
        '.cm-completionMatchedText': { color: '#18a0fb', textDecoration: 'none' },
      });

      const state = EditorState.create({
        doc: query,
        extensions: [
          theme,
          jqHighlighter,
          jqCompletion,
          keymap.of([
            {
              key: 'Enter',
              run: (view: any) => {
                const q = view.state.doc.toString();
                setQuery(q);
                executeQuery(q);
                setCollapsed(false);
                return true;
              },
            },
            {
              key: 'Mod-Enter',
              run: (view: any) => {
                const q = view.state.doc.toString();
                setQuery(q);
                executeQuery(q);
                setCollapsed(false);
                return true;
              },
            },
          ]),
          EditorView.updateListener.of((update: any) => {
            if (update.docChanged) {
              setQuery(update.state.doc.toString());
            }
          }),
        ],
      });

      const view = new EditorView({ state, parent: containerRef.current! });
      viewRef.current = view;
      view.focus();
    });

    return () => {
      cancelled = true;
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
    };
  }, []);

  // Run query when data changes (if results are visible)
  useEffect(() => {
    if (!collapsed && query) {
      executeQuery(query);
    }
  }, [data, collapsed]);

  return (
    <div className="presence-log">
      <div className="presence-log-header">
        <span className="presence-log-toggle" onClick={() => { setCollapsed(!collapsed); if (collapsed && query) executeQuery(query); }}>
          {collapsed ? '\u25b6' : '\u25bc'}
        </span>
        <strong>jq Query</strong>
        <span style={{ marginLeft: 8, fontSize: '0.7rem', color: '#888' }}>Press Enter to run</span>
      </div>
      <div className="presence-log-body" style={{ padding: 0 }}>
        <div style={{ borderBottom: collapsed ? undefined : '1px solid #333' }}>
          <div ref={containerRef} style={{ minHeight: 28 }} />
        </div>
        {!collapsed && (
          <>
            {error && (
              <pre style={{
                margin: 0, padding: '8px 12px', fontSize: '0.8rem',
                color: '#e06c75', background: '#1e1e1e', whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}>
                {error}
              </pre>
            )}
            {result && (
              <pre style={{
                margin: 0, padding: '8px 12px', fontSize: '0.8rem',
                color: '#d4d4d4', background: '#1e1e1e', whiteSpace: 'pre-wrap',
                wordBreak: 'break-all', maxHeight: '40vh', overflow: 'auto',
              }}>
                {result}
              </pre>
            )}
            {!error && !result && (
              <div style={{ padding: '8px 12px', fontSize: '0.8rem', color: '#666', background: '#1e1e1e' }}>
                Enter a jq expression and press Enter
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
