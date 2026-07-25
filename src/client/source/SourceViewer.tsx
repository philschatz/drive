import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import { openDoc, subscribeQuery, updateDoc, getDocHistory, debugGetVersionPatches, setDocVersion, restoreDocToVersion } from '../worker-api';
import { peerColor, peerDisplayName, usePresence } from '../shared/presence';
import { EditorTitleBar } from '../shared/EditorTitleBar';
import { HistorySlider } from '../shared/HistorySlider';
import type { DocumentHistory } from '../shared/useDocumentHistory';
import { usePresenceLog, PresenceLogTable } from '../shared/PresenceLog';
import { SourceTree } from './SourceTree';
import { validateDocument } from '../../shared/schemas';
import { ValidationPanel } from '../shared/ValidationPanel';
import { useAccess } from '../shared/useAccess';
import { sourcePath } from '../shared/doc-urls';
import { hashHistory } from '../hash-history';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
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


export function SourceViewer({ docId, rest, readOnly }: { docId?: string; rest?: string; readOnly?: boolean; path?: string }) {
  const [status, setStatus] = useState('Loading document...');
  const [loadProgress, setLoadProgress] = useState<number | null>(null);
  const [currentDoc, setCurrentDoc] = useState<any>(null);
  const [historyMeta, setHistoryMeta] = useState<Array<{ version: number; time: number }>>([]);
  const [changeCount, setChangeCount] = useState(0);
  const [version, setVersion] = useState(0);
  const [versionPatches, setVersionPatches] = useState<any[]>([]);
  const [docName, setDocName] = useState('Document');
  // Presence starts only once the doc handle is loaded — the engine's
  // subscribe-presence silently gives up if keyhive isn't ready yet.
  const [docLoaded, setDocLoaded] = useState(false);
  const atLatest = useRef(true);
  const titleFocusedRef = useRef(false);

  const { entries: presenceLog, addEntry: addLogEntry, clear: clearLog } = usePresenceLog();

  const { peers, peerList, broadcast } = usePresence(docLoaded ? docId : undefined, {
    onRawUpdate: (states) => {
      // Log incoming presence changes
      for (const [peerId, peer] of Object.entries(states)) {
        addLogEntry('recv', 'presence', peerId, JSON.stringify(peer.value));
      }
    },
  });

  const handleFocusPath = useCallback((path: Path | null) => {
    addLogEntry('sent', 'broadcast', 'self', `focusedField: ${JSON.stringify(path)}`);
    broadcast('focusedField', path);
  }, [addLogEntry, broadcast]);

  const peerFocusedPaths = useMemo(() => {
    const result: Array<{ path: Path; color: string; peerId: string; userGroupId?: string }> = [];
    for (const peer of Object.values(peers)) {
      const pf = peer.value?.focusedField;
      if (pf && pf.length > 0) {
        const userGroupId = peer.value?.userGroupId;
        result.push({ path: pf, color: peerColor(peer.peerId, userGroupId), peerId: peer.peerId, userGroupId });
      }
    }
    return result;
  }, [peers]);

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
    let unsubQuery: (() => void) | null = null;
    setDocLoaded(false);

    (async () => {
      setLoadProgress(0);
      // Keyhive doc announcement is eventually consistent: a doc shared moments
      // ago can reject the first find as unavailable. Retry while mounted so the
      // inspector converges instead of dead-ending on the race (the /#/d route
      // surfaces DocLoader's manual "Try again" for the same case).
      for (;;) {
        try {
          await openDoc(docId, {
            onProgress: (pct) => { if (mounted) setLoadProgress(pct); },
          });
          break;
        } catch (err: any) {
          if (!mounted) return;
          setStatus(`${err?.message || 'Failed to load document'} — retrying…`);
          await new Promise((r) => setTimeout(r, 3_000));
          if (!mounted) return;
        }
      }
      if (!mounted) return;
      setLoadProgress(null);
      setStatus('');
      setDocLoaded(true); // gate opens → usePresence subscribes

      // Subscribe to the full document via worker-api (routes through correct repo).
      // peek: inspecting/exporting source doesn't count as viewing the doc.
      unsubQuery = subscribeQuery(docId, '.', (result) => {
        if (!mounted) return;
        setCurrentDoc(result);
        if (result.name) {
          if (!titleFocusedRef.current) setDocName(result.name);
          document.title = result.name + ' - Source Editor';
        }
        setStatus('');
        loadHistory();
      }, undefined, { peek: true });

      // Initial history load will happen via the subscription callback calling loadHistory()
    })().catch((err) => {
      if (!mounted) return;
      const msg = err?.message || 'Failed to load document';
      setStatus(msg);
      setLoadProgress(null);
    });

    return () => {
      mounted = false;
      unsubQuery?.();
      // Unpin version when leaving
      if (docId) setDocVersion(docId, null);
    };
  }, [docId]);

  // Fetch patches for the selected version
  useEffect(() => {
    if (!docId || changeCount === 0) return;
    let cancelled = false;
    debugGetVersionPatches(docId, version).then(patches => {
      if (!cancelled) setVersionPatches(patches);
    }).catch(() => {
      if (!cancelled) setVersionPatches([]);
    });
    return () => { cancelled = true; };
  }, [docId, version, changeCount]);

  const isLatest = atLatest.current;
  const { canEdit: accessCanEdit } = useAccess(docId);
  const editable = isLatest && accessCanEdit && !readOnly;

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
    updateDoc(docId, (doc: any, path: any, value: any) => {
      let current = doc;
      for (let i = 0; i < path.length - 1; i++) current = current[path[i]];
      current[path[path.length - 1]] = value;
    }, path, value);
  };

  const handleDelete = (path: Path) => {
    if (!docId || !editable || path.length === 0) return;
    if (!confirm(`Delete "${path[path.length - 1]}"?`)) return;
    updateDoc(docId, (doc: any, path: any) => {
      let current = doc;
      for (let i = 0; i < path.length - 1; i++) current = current[path[i]];
      delete current[path[path.length - 1]];
    }, path);
  };

  const handleAdd = (path: Path, key: string, value: any) => {
    if (!docId || !editable) return;
    const fullPath = [...path, key];
    updateDoc(docId, (doc: any, fullPath: any, value: any) => {
      let current = doc;
      for (let i = 0; i < fullPath.length - 1; i++) current = current[fullPath[i]];
      current[fullPath[fullPath.length - 1]] = value;
    }, fullPath, value);
  };

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
    entries: historyMeta,
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
    restoreToVersion: async (target: number) => {
      if (!docId) return;
      await restoreDocToVersion(docId, target);
      // Worker clears pinnedVersion after restore; return to the live latest view.
      atLatest.current = true;
      setDocVersion(docId, null);
      loadHistory();
    },
    onNewHeads: () => {},
  };

  return (
    <div className="viewer">
      <EditorTitleBar
        icon="code"
        title={docName}
        titleEditable={editable}
        onTitleFocus={() => { titleFocusedRef.current = true; }}
        onTitleChange={setDocName}
        onTitleBlur={(value) => {
          titleFocusedRef.current = false;
          if (!docId || !editable) return;
          const name = value.trim() || 'Document';
          setDocName(name);
          updateDoc(docId, (d: any, name: string) => { d.name = name; }, name);
          document.title = name + ' - Source Editor';
        }}
        docId={docId}
        peers={peerList}
        peerTitle={(peer) => `${peerDisplayName(peer.peerId, peer.value?.userGroupId)}${peer.value?.focusedField ? ' (editing)' : ''}`}
        showSourceLink={false}

      >
        {snapshot && (
          <Button variant="outline" size="sm" onClick={handleDownloadJson}>
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>download</span> JSON
          </Button>
        )}
      </EditorTitleBar>

      {loadProgress !== null && (
        <Progress className="my-1 mx-4" value={loadProgress} />
      )}
      {status && <div className="viewer-status mx-4">{status}</div>}

      <div className="viewer-body">
        {(currentDoc || changeCount > 0) && (
          <>
            <HistorySlider history={historyAdapter} />
            <ValidationPanel
              errors={validationErrors}
              variant="dark"
              onClickError={(err) => {
                hashHistory.replace(sourcePath(docId!, err.path));
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
        )}

        <div className="viewer-panels">
          <PatchTable patches={versionPatches} />
          <PresenceLogTable entries={presenceLog} onClear={clearLog} />
          {snapshot && <JqPanel data={snapshot} docType={snapshot?.['@type']} />}
          <ClipboardInspector />
        </div>
      </div>
    </div>
  );
}
