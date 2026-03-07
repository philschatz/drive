import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import { findDocWithProgress, Automerge } from '../../shared/automerge';
import type { State } from '@automerge/automerge';
import type { DocHandle, PeerState, Presence } from '../../shared/automerge';
import { peerColor, initPresence, type PresenceState } from '../../shared/presence';
import { EditorTitleBar } from '../../shared/EditorTitleBar';
import { HistorySlider } from '../../shared/HistorySlider';
import type { DocumentHistory } from '../../shared/useDocumentHistory';
import { usePresenceLog, PresenceLogTable } from '../../shared/PresenceLog';
import type { CalendarDocument } from '../../shared/schemas';
import { SourceTree } from './SourceTree';
import { validateDocument } from '../../shared/schemas';
import { ValidationPanel } from '../../shared/ValidationPanel';
import { hashHistory } from '../hash-history';
import type { Patch } from '@automerge/automerge';
import { Progress } from '@/components/ui/progress';
import { addDocId } from '@/doc-storage';
import { JqPanel } from './JqPanel';
import './source-viewer.css';

type Path = (string | number)[];

function formatPatchPath(path: (string | number)[]): string {
  return path.map(p => typeof p === 'number' ? `[${p}]` : p).join('.');
}

function formatPatchValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '';
  if (typeof value === 'object') {
    if (Array.isArray(value)) return '[]';
    return '{}';
  }
  return JSON.stringify(value);
}

function PatchTable({ patches }: { patches: Patch[] }) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="presence-log">
      <div className="presence-log-header">
        <span className="presence-log-toggle" onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? '\u25b6' : '\u25bc'}
        </span>
        <strong>Operations</strong>
        <span className="presence-log-count">{patches.length}</span>
      </div>
      {!collapsed && (
        <div className="presence-log-body">
          <table>
            <thead>
              <tr>
                <th>Action</th>
                <th>Path</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {patches.map((p, i) => (
                <tr key={i} className={`patch-${p.action}`}>
                  <td className="patch-action">{p.action}</td>
                  <td className="patch-path">{formatPatchPath(p.path)}</td>
                  <td className="log-detail">
                    {p.action === 'put' ? formatPatchValue(p.value)
                      : p.action === 'del' ? ((p as any).length > 1 ? `×${(p as any).length}` : '')
                      : p.action === 'insert' ? (p as any).values?.map((v: unknown) => formatPatchValue(v)).join(', ')
                      : p.action === 'splice' ? JSON.stringify((p as any).value)
                      : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {patches.length === 0 && <div className="presence-log-empty">No operations for this version.</div>}
        </div>
      )}
    </div>
  );
}

type ClipFormat = { type: string; size: number } & (
  | { kind: 'text'; text: string }
  | { kind: 'image'; dataUrl: string }
  | { kind: 'binary' }
);

function ClipboardInspector() {
  const [collapsed, setCollapsed] = useState(true);
  const [items, setItems] = useState<ClipFormat[][] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const read = async () => {
    try {
      const clipboardItems = await navigator.clipboard.read();
      const result: ClipFormat[][] = [];
      for (const item of clipboardItems) {
        const formats: ClipFormat[] = [];
        for (const type of item.types) {
          const blob = await item.getType(type);
          if (type.startsWith('text/')) {
            formats.push({ kind: 'text', type, size: blob.size, text: await blob.text() });
          } else if (type.startsWith('image/')) {
            const dataUrl = await new Promise<string>(resolve => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as string);
              reader.readAsDataURL(blob);
            });
            formats.push({ kind: 'image', type, size: blob.size, dataUrl });
          } else {
            formats.push({ kind: 'binary', type, size: blob.size });
          }
        }
        result.push(formats);
      }
      setItems(result);
      setError(null);
    } catch (e) {
      setError(String(e));
      setItems(null);
    }
  };

  return (
    <div className="presence-log">
      <div className="presence-log-header">
        <span className="presence-log-toggle" onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? '\u25b6' : '\u25bc'}
        </span>
        <strong>Clipboard</strong>
        <button style={{ marginLeft: 8, fontSize: '0.75rem', padding: '1px 6px', cursor: 'pointer' }} onClick={() => { read(); setCollapsed(false); }}>
          Read
        </button>
      </div>
      {!collapsed && (
        <div className="presence-log-body">
          {error && <div style={{ color: '#c00', padding: '4px 8px' }}>{error}</div>}
          {items === null && !error && (
            <div className="presence-log-empty">Click Read to inspect the system clipboard.</div>
          )}
          {items?.length === 0 && <div className="presence-log-empty">Clipboard is empty.</div>}
          {items?.map((item, i) => (
            <div key={i} style={{ borderBottom: '1px solid #dee2e6' }}>
              {items.length > 1 && (
                <div style={{ padding: '2px 8px', fontWeight: 'bold', fontSize: '0.75rem', background: '#f1f3f5' }}>
                  Item {i + 1}
                </div>
              )}
              {item.map(fmt => (
                <div key={fmt.type}>
                  <div style={{ padding: '2px 8px 0', fontSize: '0.7rem', color: '#666', fontFamily: 'monospace' }}>
                    {fmt.type} <span style={{ color: '#aaa' }}>({fmt.size} B)</span>
                  </div>
                  {fmt.kind === 'text' ? (
                    <pre style={{ margin: 0, padding: '2px 8px 6px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: '0.8rem', color: '#ce9178' }}>
                      {fmt.text || <em style={{ color: '#aaa' }}>(empty)</em>}
                    </pre>
                  ) : fmt.kind === 'image' ? (
                    <div style={{ padding: '4px 8px 6px' }}>
                      <img src={fmt.dataUrl} style={{ maxWidth: '100%', maxHeight: 200, display: 'block' }} />
                    </div>
                  ) : (
                    <div style={{ padding: '2px 8px 6px', fontSize: '0.8rem', color: '#aaa', fontStyle: 'italic' }}>
                      binary data
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function setAtPath(obj: any, path: Path, value: any) {
  let current = obj;
  for (let i = 0; i < path.length - 1; i++) current = current[path[i]];
  current[path[path.length - 1]] = value;
}

function deleteAtPath(obj: any, path: Path) {
  let current = obj;
  for (let i = 0; i < path.length - 1; i++) current = current[path[i]];
  delete current[path[path.length - 1]];
}


export function SourceViewer({ docId, rest }: { docId?: string; rest?: string; path?: string }) {
  const [status, setStatus] = useState('Loading document...');
  const [loadProgress, setLoadProgress] = useState<number | null>(null);
  const [currentDoc, setCurrentDoc] = useState<CalendarDocument | null>(null);
  const [history, setHistory] = useState<State<CalendarDocument>[]>([]);
  const [changeCount, setChangeCount] = useState(0);
  const [version, setVersion] = useState(0);
  const [docName, setDocName] = useState('Document');
  const [peerStates, setPeerStates] = useState<Record<string, PeerState<PresenceState>>>({});
  const atLatest = useRef(true);
  const historyStale = useRef(false);
  const handleRef = useRef<DocHandle<CalendarDocument> | null>(null);
  const presenceRef = useRef<Presence<PresenceState, CalendarDocument> | null>(null);
  const presenceCleanupRef = useRef<(() => void) | null>(null);

  const { entries: presenceLog, addEntry: addLogEntry, clear: clearLog, attachToPresence } = usePresenceLog();

  const handleFocusPath = useCallback((path: Path | null) => {
    const p = presenceRef.current;
    if (!p || !p.running) return;
    addLogEntry('sent', 'broadcast', 'self', `focusedField: ${JSON.stringify(path)}`);
    p.broadcast('focusedField', path);
  }, [addLogEntry]);

  const peerFocusedPaths = useMemo(() => {
    const result: Array<{ path: Path; color: string; peerId: string }> = [];
    for (const peer of Object.values(peerStates)) {
      const pf = peer.value.focusedField;
      if (pf && pf.length > 0) {
        result.push({ path: pf, color: peerColor(peer.peerId), peerId: peer.peerId });
      }
    }
    return result;
  }, [peerStates]);

  const loadHistory = useCallback(() => {
    const handle = handleRef.current;
    if (!handle) return;
    const d = handle.doc();
    if (!d) return;
    let h: State<CalendarDocument>[];
    try {
      h = Automerge.getHistory(d);
    } catch (e) {
      console.error('Automerge.getHistory failed:', e);
      return;
    }
    historyStale.current = false;
    setHistory(h);
    setChangeCount(h.length);
    if (atLatest.current) {
      setVersion(h.length - 1);
    }
  }, []);

  useEffect(() => {
    if (!docId) {
      setStatus('No document ID. Go to the home page to select a document.');
      return;
    }

    let mounted = true;
    const mountedRef = { current: true };

    (async () => {
      setLoadProgress(0);
      const handle = await findDocWithProgress<CalendarDocument>(docId, setLoadProgress);
      const doc = handle.doc();
      if (!mounted) return;
      if (!doc) {
        setStatus('Document not found. Check the URL.');
        return;
      }
      addDocId(docId);
      handleRef.current = handle;

      // Show current doc immediately — no getHistory needed
      setCurrentDoc(doc);
      if (doc.name) setDocName(doc.name);
      document.title = (doc.name || 'Document') + ' - Source Editor';
      setStatus('');

      // Presence
      const { presence, cleanup: presenceCleanup } = initPresence<PresenceState>(
        handle,
        () => ({ viewing: true, focusedField: null }),
        (states) => { if (mounted) setPeerStates(states); },
      );
      presenceRef.current = presence;
      presenceCleanupRef.current = presenceCleanup;

      // Log presence events
      attachToPresence(presence, mountedRef);

      // Load history in the background — doesn't block initial render
      setTimeout(() => {
        if (!mounted) return;
        try {
          const h = Automerge.getHistory(doc);
          setHistory(h);
          setChangeCount(h.length);
          setVersion(h.length - 1);
        } catch (e) {
          console.error('Automerge.getHistory failed:', e);
        }
      }, 0);

      // On document changes, only update the live doc — never recompute history
      handle.on('change', () => {
        const d = handle.doc();
        if (!d || !mounted) return;
        setCurrentDoc(d);
        if (d.name) {
          setDocName(d.name);
          document.title = d.name + ' - Source Editor';
        }
        historyStale.current = true;
        if (atLatest.current) {
          setChangeCount(prev => prev + 1);
          setVersion(prev => prev + 1);
        }
      });
    })().catch((err) => {
      if (!mounted) return;
      const msg = err?.message || 'Failed to load document';
      setStatus(msg);
      setLoadProgress(null);
    });

    return () => {
      mounted = false;
      mountedRef.current = false;
      presenceCleanupRef.current?.();
      presenceRef.current = null;
      presenceCleanupRef.current = null;
    };
  }, [docId]);

  const isLatest = atLatest.current;
  const editable = isLatest;

  // Resolve the snapshot: use currentDoc when at latest, history entry otherwise
  const snapshot = useMemo(() => {
    if (isLatest && currentDoc) return currentDoc;
    const entry = history[version];
    if (!entry) return currentDoc; // fallback to current doc while history loads
    try {
      return entry.snapshot;
    } catch (e) {
      console.error('Failed to resolve snapshot:', e);
      return null;
    }
  }, [isLatest, currentDoc, history, version]);

  const entry = history[version];

  const versionPatches = useMemo(() => {
    if (history.length === 0) return [];
    const doc = currentDoc || history[history.length - 1]?.snapshot;
    if (!doc) return [];
    try {
      const afterHeads = Automerge.getHeads(history[version]?.snapshot ?? doc);
      const beforeHeads = version > 0
        ? Automerge.getHeads(history[version - 1].snapshot)
        : [];
      return Automerge.diff(doc, beforeHeads, afterHeads);
    } catch (e) {
      console.error('Failed to compute patches:', e);
      return [];
    }
  }, [version, history, currentDoc]);

  const validationErrors = useMemo(() => {
    if (!snapshot) return [];
    return validateDocument(snapshot);
  }, [snapshot]);

  const [revealPath, setRevealPath] = useState<Path | null>(null);
  const hashConsumedRef = useRef(false);

  // On first render with data, consume the hash as a revealPath
  useEffect(() => {
    if (hashConsumedRef.current || !snapshot) return;
    const initial = rest
      ? rest.split('/').filter(Boolean).map((s: string) => {
          const decoded = decodeURIComponent(s);
          const n = Number(decoded);
          return !isNaN(n) && decoded.trim() !== '' ? n : decoded;
        })
      : null;
    if (initial) {
      hashConsumedRef.current = true;
      setRevealPath(initial);
    }
  }, [snapshot]);

  const jumpToLatest = () => {
    atLatest.current = true;
    setVersion(changeCount - 1);
  };

  const handleEdit = (path: Path, value: any) => {
    if (!handleRef.current || !editable) return;
    handleRef.current.change((doc: any) => {
      setAtPath(doc, path, value);
    });
  };

  const handleDelete = (path: Path) => {
    if (!handleRef.current || !editable || path.length === 0) return;
    handleRef.current.change((doc: any) => {
      deleteAtPath(doc, path);
    });
  };

  const handleAdd = (path: Path, key: string, value: any) => {
    if (!handleRef.current || !editable) return;
    handleRef.current.change((doc: any) => {
      setAtPath(doc, [...path, key], value);
    });
  };

  const peerList = Object.values(peerStates).filter(p => p.value.viewing);

  const historyAdapter: DocumentHistory<CalendarDocument> = {
    active: changeCount > 0,
    editable,
    isLatest,
    version,
    changeCount,
    snapshot: null,
    time: entry?.change.time ?? null,
    toggleHistory: () => {},
    onSliderChange: (v: number) => {
      const latest = v === changeCount - 1;
      atLatest.current = latest;
      if (!latest && historyStale.current) loadHistory();
      setVersion(v);
    },
    jumpToLatest,
    undoToVersion: () => {
      const handle = handleRef.current;
      if (!handle || isLatest || !entry) return;
      const snap = entry.snapshot;
      if (!snap) return;
      const plain = JSON.parse(JSON.stringify(snap));
      handle.change((d: any) => {
        for (const key of Object.keys(d)) {
          if (!(key in plain)) delete d[key];
        }
        for (const [key, val] of Object.entries(plain)) {
          (d as any)[key] = val;
        }
      });
      jumpToLatest();
    },
  };

  return (
    <div className="viewer">
      <EditorTitleBar
        icon="code"
        title={docName}
        docId={docId}
        peers={peerList}
        showSourceLink={false}
      />

      {loadProgress !== null && (
        <Progress className="my-1" value={loadProgress} />
      )}
      {status && <div className="viewer-status">{status}</div>}

      {(currentDoc || history.length > 0) && (
        <>
          <HistorySlider history={historyAdapter} dismissable={false} />

          <>
            <ValidationPanel
              errors={validationErrors}
              variant="dark"
              onClickError={(err) => {
                const pathStr = err.path.map((s: string | number) => encodeURIComponent(String(s))).join('/');
                hashHistory.replace(`/source/${docId}/${pathStr}`);
                setRevealPath(null);
                requestAnimationFrame(() => setRevealPath(err.path));
              }}
            />
            {snapshot ? (
              <SourceTree
                data={snapshot}
                editable={editable}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onAdd={handleAdd}
                peerFocusedPaths={peerFocusedPaths}
                onFocusPath={handleFocusPath}
                errors={validationErrors}
                revealPath={revealPath}
              />
            ) : (
              <div className="viewer-status">Failed to load snapshot for this version.</div>
            )}
          </>
        </>
      )}

      <PatchTable patches={versionPatches} />
      <PresenceLogTable entries={presenceLog} onClear={clearLog} />
      {snapshot && <JqPanel data={snapshot} docType={snapshot?.['@type']} />}
      <ClipboardInspector />
    </div>
  );
}
