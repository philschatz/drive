import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import { openDoc, subscribeQuery, updateDoc, richText, getDocHistory, debugGetVersionPatches, setDocVersion, restoreDocToVersion, type MarkerField } from '../worker-api';
import { flatTextEditOps, flatTextFromSpans, type RichTextOp, type RichTextSpan } from '../../../shared/rich-text-ops';
import { peerColor, peerDisplayName, usePresence } from '../common/presence';
import { DocumentTitleBar } from '../common/DocumentTitleBar';
import { HistorySlider } from '../common/HistorySlider';
import type { DocumentHistory } from '../common/useDocumentHistory';
import { SourceTree } from './SourceTree';
import { validateDocument } from '../../../shared/schemas';
import { ValidationPanel } from '../common/ValidationPanel';
import { useAccess } from '../common/useAccess';
import { sourcePath } from '../common/doc-urls';
import { hashHistory } from '../hash-history';
import { Progress } from '@/components/ui/progress';
import './source-viewer.css';

type Path = (string | number)[];

function formatPatchPath(path: (string | number)[]): string {
  return path.map(p => typeof p === 'number' ? `[${p}]` : p).join('.');
}

function formatPatchValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '';
  if (typeof value === 'object') return Array.isArray(value) ? '[]' : '{}';
  return JSON.stringify(value);
}

/**
 * An `insert` into a text field whose value is a map IS a block marker —
 * Automerge inserts an empty map at the marker's position and fills it in with
 * later `put` patches. Only in that position, though: a `put` of a map is an
 * ordinary object (a block's own `attrs`, say), and labelling those as markers
 * too is worse than saying nothing.
 */
function formatInsertedValue(value: unknown): string {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? '¶ block marker'
    : formatPatchValue(value);
}

/** `strong=true, link={"href":…}` — the mark set riding along with an insert. */
function formatMarkSet(marks: Record<string, unknown> | undefined): string {
  if (!marks) return '';
  const entries = Object.entries(marks);
  if (entries.length === 0) return '';
  return entries.map(([name, v]) => `${name}=${formatPatchValue(v)}`).join(', ');
}

/**
 * The Value column for one patch.
 *
 * Automerge reports a mark and an unmark as their own patch actions carrying a
 * range, and inserted text can carry an inherited mark set — none of which the
 * generic value formatter can show, so a formatting change used to appear as a
 * bare row with an empty Value. Block markers need the same treatment: they
 * arrive as an `insert` of a map, which read as `{}`.
 */
function formatPatchDetail(p: any): string {
  switch (p.action) {
    case 'put':
      return formatPatchValue(p.value);
    case 'del':
      return p.length > 1 ? `×${p.length}` : '';
    case 'insert': {
      const values = (p.values ?? []).map((v: unknown) => formatInsertedValue(v)).join(', ');
      const marks = formatMarkSet(p.marks);
      return marks ? `${values} (${marks})` : values;
    }
    case 'splice': {
      // Show the block-marker character rather than letting it render as tofu.
      const text = JSON.stringify(String(p.value ?? '')).replace(/￼/g, '\\uFFFC');
      const marks = formatMarkSet(p.marks);
      return marks ? `${text} (${marks})` : text;
    }
    case 'mark':
      return (p.marks ?? [])
        .map((m: any) => `${m.name}=${formatPatchValue(m.value)} [${m.start}, ${m.end})`)
        .join(', ');
    case 'unmark':
      return `${p.name} [${p.start}, ${p.end})`;
    case 'inc':
      return p.value > 0 ? `+${p.value}` : String(p.value);
    default:
      return '';
  }
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
                  <td className="log-detail">{formatPatchDetail(p)}</td>
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


export function SourceViewer({ docId, rest, readOnly }: { docId?: string; rest?: string; readOnly?: boolean; path?: string }) {
  const [status, setStatus] = useState('Loading document...');
  const [loadProgress, setLoadProgress] = useState<number | null>(null);
  const [currentDoc, setCurrentDoc] = useState<any>(null);
  // Every string field carrying markers — marks and block markers are invisible
  // to the jq projection, so the tree gets them through this side channel.
  const [markerFields, setMarkerFields] = useState<MarkerField[]>([]);
  const [historyMeta, setHistoryMeta] = useState<Array<{ version: number; time: number }>>([]);
  const [changeCount, setChangeCount] = useState(0);
  const [version, setVersion] = useState(0);
  // The version-history sheet starts closed (it covered the document you came
  // here to read); open it from the title-bar History menu item.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versionPatches, setVersionPatches] = useState<any[]>([]);
  const [docName, setDocName] = useState('Document');
  // Presence starts only once the doc handle is loaded — the engine's
  // subscribe-presence silently gives up if keyhive isn't ready yet.
  const [docLoaded, setDocLoaded] = useState(false);
  const atLatest = useRef(true);

  const { peers, peerList, broadcast } = usePresence(docLoaded ? docId : undefined);

  const handleFocusPath = useCallback((path: Path | null) => {
    broadcast('focusedField', path);
  }, [broadcast]);

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
      unsubQuery = subscribeQuery(docId, '.', (result, _heads, _lastModified, _spans, _cursors, richTextFields) => {
        if (!mounted) return;
        setCurrentDoc(result);
        setMarkerFields(richTextFields ?? []);
        if (result.name) {
          setDocName(result.name);
          document.title = result.name + ' - Source Editor';
        }
        setStatus('');
        loadHistory();
      }, undefined, { peek: true, allRichText: true });

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

  /** path key → that field's spans, for the tree's marker rendering. */
  const markerSpans = useMemo(() => {
    const map = new Map<string, RichTextSpan[]>();
    for (const f of markerFields) map.set(f.path.join('/'), f.spans);
    return map;
  }, [markerFields]);

  const validationErrors = useMemo(() => {
    if (!snapshot) return [];
    // The engine already validated the paths the schema DECLARES as rich text;
    // passing the discovered set adds the markers on fields it doesn't.
    return validateDocument(snapshot, markerFields);
  }, [snapshot, markerFields]);

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

  /**
   * Apply rich-text ops to one field. One call is one Automerge change, so a
   * marker edit is a single history entry and a single undo step.
   */
  const handleRichTextOps = useCallback((path: Path, ops: RichTextOp[]) => {
    if (!docId || !editable || ops.length === 0) return;
    updateDoc(docId, (doc: any, richText: any, path: any, ops: any) => {
      richText(doc, path, ops);
    }, richText, path, ops);
  }, [docId, editable]);

  const handleEdit = (path: Path, value: any) => {
    if (!docId || !editable) return;
    // A field carrying markers must never be written by assignment: replacing
    // the text object flattens every mark and turns its block markers into
    // literal `￼` characters. Diff the flat text into ops instead.
    const spans = markerSpans.get(path.join('/'));
    if (spans) {
      handleRichTextOps(path, flatTextEditOps(flatTextFromSpans(spans), String(value)));
      return;
    }
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
    active: historyOpen && changeCount > 0,
    editable,
    isLatest,
    version,
    changeCount,
    entries: historyMeta,
    time: versionTime,
    toggleHistory: () => {
      // Closing also returns the view to the live latest version so the source
      // tree never stays silently pinned to an old snapshot.
      if (historyOpen) jumpToLatest();
      setHistoryOpen(!historyOpen);
    },
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
      <DocumentTitleBar
        icon="code"
        title={docName}
        titleEditable={editable}
        onRename={(value) => {
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
        onToggleHistory={historyAdapter.toggleHistory}
        historyActive={historyAdapter.active}
        // Inspecting changes is the point of this view, so History sits on the bar.
        historyPlacement="bar"
        overflow={snapshot ? [{ icon: 'download', label: 'Download JSON', onSelect: handleDownloadJson }] : []}
      />

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
                markerSpans={markerSpans}
                onRichTextOps={handleRichTextOps}
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
        </div>
      </div>
    </div>
  );
}
