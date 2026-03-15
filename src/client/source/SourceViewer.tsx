import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import type { PeerState } from '../../shared/automerge';
import { openDoc, subscribeQuery, updateDoc, getDocHistory, setDocVersion } from '../worker-api';
import { getDocEntry } from '../doc-storage';
import { peerColor, initPresence, type PresenceState } from '../../shared/presence';
import { EditorTitleBar } from '../../shared/EditorTitleBar';
import { HistorySlider } from '../../shared/HistorySlider';
import type { DocumentHistory } from '../../shared/useDocumentHistory';
import { usePresenceLog, PresenceLogTable } from '../../shared/PresenceLog';
import { SourceTree } from './SourceTree';
import { validateDocument } from '../../shared/schemas';
import { ValidationPanel } from '../../shared/ValidationPanel';
import { hashHistory } from '../hash-history';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
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

function PatchTable({ patches }: { patches: any[] }) {
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


export function SourceViewer({ docId, rest }: { docId?: string; rest?: string; path?: string }) {
  const [status, setStatus] = useState('Loading document...');
  const [loadProgress, setLoadProgress] = useState<number | null>(null);
  const [currentDoc, setCurrentDoc] = useState<any>(null);
  const [historyMeta, setHistoryMeta] = useState<Array<{ version: number; time: number }>>([]);
  const [changeCount, setChangeCount] = useState(0);
  const [version, setVersion] = useState(0);
  const versionPatches: any[] = [];
  const [docName, setDocName] = useState('Document');
  const [peerStates, setPeerStates] = useState<Record<string, PeerState<PresenceState>>>({});
  const atLatest = useRef(true);
  const broadcastRef = useRef<((key: keyof PresenceState, value: any) => void) | null>(null);
  const presenceCleanupRef = useRef<(() => void) | null>(null);

  const { entries: presenceLog, addEntry: addLogEntry, clear: clearLog } = usePresenceLog();

  const handleFocusPath = useCallback((path: Path | null) => {
    if (!broadcastRef.current) return;
    addLogEntry('sent', 'broadcast', 'self', `focusedField: ${JSON.stringify(path)}`);
    broadcastRef.current('focusedField', path);
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

  // Load history metadata from worker
  const loadHistory = useCallback(() => {
    if (!docId) return;
    getDocHistory(docId).then((h) => {
      setHistoryMeta(h);
      setChangeCount(h.length);
      if (atLatest.current && h.length > 0) {
        setVersion(h.length - 1);
      }
    }).catch(e => console.error('getDocHistory failed:', e));
  }, [docId]);

  useEffect(() => {
    if (!docId) {
      setStatus('No document ID. Go to the home page to select a document.');
      return;
    }

    let mounted = true;

    (async () => {
      setLoadProgress(0);
      const entry = getDocEntry(docId);
      await openDoc(docId, {
        secure: entry?.encrypted,
        onProgress: (pct) => { if (mounted) setLoadProgress(pct); },
      });
      if (!mounted) return;
      setLoadProgress(null);
      addDocId(docId);

      // Subscribe to the full document via worker-api (routes through correct repo)
      const unsubQuery = subscribeQuery(docId, '.', (result) => {
        if (!mounted) return;
        setCurrentDoc(result);
        if (result.name) {
          setDocName(result.name);
          document.title = result.name + ' - Source Editor';
        }
        setStatus('');
        // Track change count for history slider
        setChangeCount(prev => {
          const next = prev + (prev === 0 ? 0 : 1);
          if (atLatest.current) setVersion(next > 0 ? next - 1 : 0);
          return next;
        });
      });

      // Presence
      const { broadcast, cleanup: presenceCleanup } = initPresence<PresenceState>(
        docId,
        () => ({ viewing: true, focusedField: null }),
        (states) => { if (mounted) setPeerStates(states); },
      );
      broadcastRef.current = broadcast;
      presenceCleanupRef.current = () => { unsubQuery(); presenceCleanup(); };

      // Load history metadata in the background
      getDocHistory(docId).then((h) => {
        if (!mounted) return;
        setHistoryMeta(h);
        setChangeCount(h.length);
        if (h.length > 0) setVersion(h.length - 1);
      }).catch(e => console.error('getDocHistory failed:', e));
    })().catch((err) => {
      if (!mounted) return;
      const msg = err?.message || 'Failed to load document';
      setStatus(msg);
      setLoadProgress(null);
    });

    return () => {
      mounted = false;
      presenceCleanupRef.current?.();
      broadcastRef.current = null;
      presenceCleanupRef.current = null;
      // Unpin version when leaving
      if (docId) setDocVersion(docId, null);
    };
  }, [docId]);

  const isLatest = atLatest.current;
  const editable = isLatest;

  // currentDoc is always the live or pinned doc from subscribeQuery
  const snapshot = currentDoc;

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
    setDocVersion(docId!, null);
  };

  const handleEdit = (path: Path, value: any) => {
    if (!docId || !editable) return;
    updateDoc(docId, (doc: any) => {
      let current = doc;
      for (let i = 0; i < path.length - 1; i++) current = current[path[i]];
      current[path[path.length - 1]] = value;
    }, { path, value });
  };

  const handleDelete = (path: Path) => {
    if (!docId || !editable || path.length === 0) return;
    updateDoc(docId, (doc: any) => {
      let current = doc;
      for (let i = 0; i < path.length - 1; i++) current = current[path[i]];
      delete current[path[path.length - 1]];
    }, { path });
  };

  const handleAdd = (path: Path, key: string, value: any) => {
    if (!docId || !editable) return;
    const fullPath = [...path, key];
    updateDoc(docId, (doc: any) => {
      let current = doc;
      for (let i = 0; i < fullPath.length - 1; i++) current = current[fullPath[i]];
      current[fullPath[fullPath.length - 1]] = value;
    }, { fullPath, value });
  };

  const peerList = Object.values(peerStates).filter(p => p.value.viewing);

  const handleDownloadJson = useCallback(() => {
    if (!snapshot) return;
    const json = JSON.stringify(snapshot, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (docName || 'document') + '.json';
    a.click();
    URL.revokeObjectURL(url);
  }, [snapshot, docName]);

  const versionTime = historyMeta[version]?.time ?? null;

  const historyAdapter: DocumentHistory = {
    active: changeCount > 0,
    editable,
    isLatest,
    version,
    changeCount,
    time: versionTime,
    toggleHistory: () => {},
    onSliderChange: (v: number) => {
      const latest = v === changeCount - 1;
      atLatest.current = latest;
      setVersion(v);
      // Pin/unpin the worker subscription to this version
      if (docId) setDocVersion(docId, latest ? null : v);
      // Refresh history metadata if stale
      if (!latest) loadHistory();
    },
    jumpToLatest,
    undoToVersion: () => {},
    onNewHeads: () => {},
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

      {snapshot && (
        <div className="flex items-center gap-2 mb-2">
          <Button variant="outline" size="sm" onClick={handleDownloadJson}>
            <span className="material-symbols-outlined">download</span> Download JSON
          </Button>
        </div>
      )}

      {loadProgress !== null && (
        <Progress className="my-1" value={loadProgress} />
      )}
      {status && <div className="viewer-status">{status}</div>}

      {(currentDoc || changeCount > 0) && (
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
