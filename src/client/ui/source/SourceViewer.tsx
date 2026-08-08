/**
 * The source inspector — the raw document, one level at a time.
 *
 * Two jobs: navigate the document, and see what a version's operations did. Both
 * are built for a phone first.
 *
 * **The URL is the navigation state.** `#/source/<id>/<path>` already existed as a
 * deep-link target (the validation warning in every editor's title bar points
 * here), so the current level is simply whatever `rest` decodes to — there is no
 * local path state, and browser Back walks back up the tree. That also means the
 * three callers who deep-link here need no special handling: `resolveLevel` walks
 * as far as the document allows and treats a leftover segment as a row to point
 * at, which covers a validation error's leaf path, another editor's focused field,
 * and an operation's raw patch path (whose last segment may be a text offset).
 *
 * Writes go through the same three handlers as before, and the one rule that
 * matters is unchanged: a field carrying rich-text markers is NEVER written by
 * assignment — that would replace the text object, flattening every mark and
 * turning its block markers into literal `￼` characters.
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import {
  openDoc, subscribeQuery, updateDoc, richText, getDocHistory, debugGetVersionPatches,
  setDocVersion, restoreDocToVersion, type MarkerField,
} from '../worker-api';
import {
  flatTextEditOps, flatTextFromSpans, markersFromSpans,
  type RichTextOp, type RichTextSpan,
} from '../../../shared/rich-text-ops';
import { peerDisplayName, usePresence } from '../common/presence';
import { DocumentTitleBar } from '../common/DocumentTitleBar';
import type { DocumentHistory } from '../common/useDocumentHistory';
import { validateDocument } from '../../../shared/schemas';
import { useAccess } from '../common/useAccess';
import { useConfirm } from '../common/ConfirmSheet';
import { sourcePath } from '../common/doc-urls';
import { hashHistory } from '../hash-history';
import { Progress } from '@/components/ui/progress';
import { Fab } from '@/components/ui/fab';
import { LevelList, type PeerFocus, type RowTarget } from './LevelList';
import { FieldScreen } from './FieldScreen';
import { ChangesSheet } from './ChangesSheet';
import { ValidationList } from './ValidationList';
import { AddPropertySheet, ValueSheet } from './ValueSheets';
import {
  collectChangedPaths, escapeString, isContainer, parseValue, pathFromRest,
  resolveLevel, unescapeString, valueAt, type Path,
} from './source-nodes';
import './source.css';

const EMPTY_SET: Set<string> = new Set();

/** The path chips above the level: where you are, and every way back up. */
function Breadcrumb({ path, onNavigate }: { path: Path; onNavigate: (p: Path) => void }) {
  return (
    <nav
      aria-label="Document path"
      data-testid="source-breadcrumb"
      className="sticky top-14 z-10 bg-page flex items-center gap-0.5 overflow-x-auto whitespace-nowrap py-1.5 px-1 border-b border-outline-variant"
    >
      <button
        aria-label="Document root"
        data-testid="crumb-root"
        className="inline-flex items-center justify-center h-9 w-9 rounded-full state-layer shrink-0"
        onClick={() => onNavigate([])}
      >
        <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 20 }}>home</span>
      </button>
      {path.map((seg, i) => {
        const last = i === path.length - 1;
        return (
          <span key={i} className="flex items-center shrink-0">
            <span className="text-muted-foreground px-0.5" aria-hidden="true">/</span>
            <button
              data-testid="crumb"
              // The last crumb is where you already are, so it doesn't navigate.
              disabled={last}
              className={
                'src-mono md-body-medium rounded-full px-2 py-1.5 max-w-40 truncate ' +
                (last ? 'font-semibold text-on-surface' : 'state-layer text-muted-foreground')
              }
              onClick={last ? undefined : () => onNavigate(path.slice(0, i + 1))}
            >
              {String(seg)}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

export function SourceViewer({ docId, rest, readOnly }: { docId?: string; rest?: string; readOnly?: boolean; path?: string }) {
  const [status, setStatus] = useState('Loading document…');
  const [loadProgress, setLoadProgress] = useState<number | null>(null);
  const [currentDoc, setCurrentDoc] = useState<any>(null);
  // Every string field carrying markers — marks and block markers are invisible
  // to the jq projection, so they arrive through this side channel.
  const [markerFields, setMarkerFields] = useState<MarkerField[]>([]);
  const [historyMeta, setHistoryMeta] = useState<Array<{ version: number; time: number }>>([]);
  const [changeCount, setChangeCount] = useState(0);
  const [version, setVersion] = useState(0);
  // The changes sheet starts closed (it would cover the document you came here to
  // read); open it from the title bar's History button.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versionPatches, setVersionPatches] = useState<any[]>([]);
  const [docName, setDocName] = useState('Document');
  // Presence starts only once the doc handle is loaded — the engine's
  // subscribe-presence silently gives up if keyhive isn't ready yet.
  const [docLoaded, setDocLoaded] = useState(false);
  const atLatest = useRef(true);

  // Open sheets. Each holds its own target, so none of them needs the others.
  const [editing, setEditing] = useState<RowTarget | null>(null);
  const [adding, setAdding] = useState(false);
  const { confirm, confirmSheet } = useConfirm();

  const { peers, peerList, broadcast } = usePresence(docLoaded ? docId : undefined);

  const peerFocusedPaths = useMemo<PeerFocus[]>(() => {
    const result: PeerFocus[] = [];
    for (const peer of Object.values(peers)) {
      const pf = peer.value?.focusedField;
      if (pf && pf.length > 0) {
        result.push({ path: pf, peerId: peer.peerId, userGroupId: peer.value?.userGroupId });
      }
    }
    return result;
  }, [peers]);

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
      // inspector converges instead of dead-ending on the race.
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

      // peek: inspecting the source doesn't count as viewing the document.
      // allRichText: also deliver the spans of every field that carries markers.
      unsubQuery = subscribeQuery(docId, '.', (result, _heads, _lastModified, _spans, _cursors, richTextFields) => {
        if (!mounted) return;
        setCurrentDoc(result);
        setMarkerFields(richTextFields ?? []);
        if (result?.name) {
          setDocName(result.name);
          document.title = result.name + ' - Source';
        }
        setStatus('');
        loadHistory();
      }, undefined, { peek: true, allRichText: true });
    })().catch((err) => {
      if (!mounted) return;
      setStatus(err?.message || 'Failed to load document');
      setLoadProgress(null);
    });

    return () => {
      mounted = false;
      unsubQuery?.();
      // Leaving must unpin, or the doc stays on an old snapshot all session.
      if (docId) setDocVersion(docId, null);
    };
  }, [docId]);

  // Operations for the selected version.
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

  const snapshot = currentDoc;

  /** path key → that field's spans / marker count, for the rows and field screen. */
  const spansByKey = useMemo(() => {
    const map = new Map<string, RichTextSpan[]>();
    for (const f of markerFields) map.set(f.path.join('/'), f.spans);
    return map;
  }, [markerFields]);

  const richPaths = useMemo(() => new Set(spansByKey.keys()), [spansByKey]);

  const markerCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const [key, spans] of spansByKey) map.set(key, markersFromSpans(spans).length);
    return map;
  }, [spansByKey]);

  const validationErrors = useMemo(() => {
    if (!snapshot) return [];
    // The engine already validated the paths the schema DECLARES as rich text;
    // passing the discovered set adds the markers on fields it doesn't.
    return validateDocument(snapshot, markerFields);
  }, [snapshot, markerFields]);

  // ── Navigation ───────────────────────────────────────────────────────────
  // `rest` IS the current path, so navigating is pushing a hash and letting the
  // router deliver it back. No local copy to keep in sync.
  const requestedPath = useMemo(() => pathFromRest(rest), [rest]);
  const level = useMemo(
    () => resolveLevel(snapshot, requestedPath, richPaths),
    [snapshot, requestedPath, richPaths],
  );

  const navigate = useCallback((path: Path) => {
    if (docId) hashHistory.push(sourcePath(docId, path));
  }, [docId]);

  // ── Change flash ─────────────────────────────────────────────────────────
  // Ancestors are included, so an edit deeper than the level on screen still
  // shows up — as a flash on the container row that leads to it.
  const prevDocRef = useRef(snapshot);
  const [changedPaths, setChangedPaths] = useState<Set<string>>(EMPTY_SET);
  useEffect(() => {
    const prev = prevDocRef.current;
    prevDocRef.current = snapshot;
    if (prev === snapshot || prev == null || snapshot == null) return;
    const paths = new Set<string>();
    collectChangedPaths(prev, snapshot, [], paths);
    paths.delete(''); // the root has no row to flash
    if (paths.size === 0) return;
    setChangedPaths(paths);
    const id = setTimeout(() => setChangedPaths(EMPTY_SET), 600);
    return () => clearTimeout(id);
  }, [snapshot]);

  // ── Presence ─────────────────────────────────────────────────────────────
  // Broadcast the field being edited, and clear it when the sheet closes.
  const editingKey = editing ? editing.path.join('/') : '';
  useEffect(() => {
    if (!editing) return;
    broadcast('focusedField', editing.path);
    return () => broadcast('focusedField', null);
  }, [editingKey]);

  // ── Writes ───────────────────────────────────────────────────────────────

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

  const handleEdit = useCallback((path: Path, value: any) => {
    if (!docId || !editable) return;
    // A field carrying markers must never be written by assignment: replacing the
    // text object flattens every mark and turns its block markers into literal
    // `￼` characters. Diff the flat text into ops instead.
    const spans = spansByKey.get(path.join('/'));
    if (spans) {
      handleRichTextOps(path, flatTextEditOps(flatTextFromSpans(spans), String(value)));
      return;
    }
    updateDoc(docId, (doc: any, path: any, value: any) => {
      let current = doc;
      for (let i = 0; i < path.length - 1; i++) current = current[path[i]];
      current[path[path.length - 1]] = value;
    }, path, value);
  }, [docId, editable, spansByKey, handleRichTextOps]);

  /** A rich-text field's whole text, replaced by the minimal set of ops. */
  const handleSetText = useCallback((path: Path, raw: string) => {
    const spans = spansByKey.get(path.join('/'));
    if (!spans) return;
    handleRichTextOps(path, flatTextEditOps(flatTextFromSpans(spans), unescapeString(raw)));
  }, [spansByKey, handleRichTextOps]);

  const handleDelete = useCallback(async (target: RowTarget) => {
    if (!docId || !editable || target.path.length === 0) return;
    if (!await confirm({
      title: `Delete "${target.key}"?`,
      body: isContainer(target.value)
        ? 'Everything inside it is deleted too. You can undo this from version history.'
        : 'You can undo this from version history.',
      confirmLabel: 'Delete',
      destructive: true,
    })) return;
    updateDoc(docId, (doc: any, path: any) => {
      let current = doc;
      for (let i = 0; i < path.length - 1; i++) current = current[path[i]];
      delete current[path[path.length - 1]];
    }, target.path);
  }, [docId, editable, confirm]);

  const handleAdd = useCallback((key: string, raw: string) => {
    if (!docId || !editable) return;
    const fullPath = [...level.levelPath, key];
    updateDoc(docId, (doc: any, fullPath: any, value: any) => {
      let current = doc;
      for (let i = 0; i < fullPath.length - 1; i++) current = current[fullPath[i]];
      current[fullPath[fullPath.length - 1]] = value;
    }, fullPath, parseValue(raw));
  }, [docId, editable, level.levelPath]);

  const handleDownloadJson = useCallback(() => {
    if (!snapshot) return;
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (docName || 'document') + '.json';
    a.click();
    URL.revokeObjectURL(url);
  }, [snapshot, docName]);

  // ── History adapter ──────────────────────────────────────────────────────
  // Not `useDocumentHistory`: this view always tracks a version, whether or not
  // the sheet is open, because the operations list needs one to show.
  const jumpToLatest = useCallback(() => {
    atLatest.current = true;
    setVersion(changeCount - 1);
    if (docId) setDocVersion(docId, null);
  }, [changeCount, docId]);

  const history: DocumentHistory = {
    active: historyOpen && changeCount > 0,
    editable,
    isLatest,
    version,
    changeCount,
    entries: historyMeta,
    time: historyMeta[version]?.time ?? null,
    toggleHistory: () => {
      // Closing also returns the view to the live latest version, so the document
      // never stays silently pinned to an old snapshot.
      if (historyOpen) jumpToLatest();
      setHistoryOpen(!historyOpen);
    },
    onSliderChange: (v: number) => {
      const latest = v === changeCount - 1;
      atLatest.current = latest;
      setVersion(v);
      if (docId) setDocVersion(docId, latest ? null : v);
      if (!latest) loadHistory();
    },
    jumpToLatest,
    restoreToVersion: async (target: number) => {
      if (!docId) return;
      await restoreDocToVersion(docId, target);
      // The worker clears pinnedVersion after a restore; return to the live view.
      atLatest.current = true;
      setDocVersion(docId, null);
      loadHistory();
    },
    onNewHeads: () => {},
  };

  // ── Render ───────────────────────────────────────────────────────────────

  const levelValue = snapshot ? valueAt(snapshot, level.levelPath) : undefined;
  const fieldSpans = level.fieldPath ? spansByKey.get(level.fieldPath.join('/')) : undefined;
  const fieldText = level.fieldPath && snapshot ? valueAt(snapshot, level.fieldPath) : undefined;

  return (
    <>
      <DocumentTitleBar
        icon="code"
        title={docName}
        titleEditable={editable}
        onRename={(value) => {
          if (!docId || !editable) return;
          const name = value.trim() || 'Document';
          setDocName(name);
          updateDoc(docId, (d: any, name: string) => { d.name = name; }, name);
          document.title = name + ' - Source';
        }}
        docId={docId}
        peers={peerList}
        peerTitle={(peer) => `${peerDisplayName(peer.peerId, peer.value?.userGroupId)}${peer.value?.focusedField ? ' (editing)' : ''}`}
        showSourceLink={false}
        onToggleHistory={history.toggleHistory}
        historyActive={history.active}
        // Inspecting changes is the point of this view, so History sits on the bar.
        historyPlacement="bar"
        // This bar never hides: the breadcrumb sticks below it, and History and the
        // kebab have to stay reachable while reading down a long level.
        hidden={false}
        overflow={snapshot ? [{ icon: 'download', label: 'Download JSON', onSelect: handleDownloadJson }] : []}
      />

      {loadProgress !== null && <Progress className="my-1 mx-4" value={loadProgress} />}

      {snapshot && <Breadcrumb path={level.fieldPath ?? level.levelPath} onNavigate={navigate} />}

      {/* pb-28 clears the FAB, per the convention every list screen follows. */}
      <div className="max-w-screen-md mx-auto w-full px-2 sm:px-4 pb-28">
        {status && <div className="text-sm text-muted-foreground py-2 px-2">{status}</div>}

        {!isLatest && changeCount > 0 && (
          <div
            className="md-body-medium text-on-secondary-container bg-secondary-container rounded-lg px-3 py-2 mt-2"
            data-testid="pinned-notice"
          >
            Showing version {version + 1} of {changeCount}. Editing is disabled while a past version is
            previewed.
          </div>
        )}

        {level.missing && (
          <div
            className="md-body-medium text-on-error-container bg-error-container rounded-lg px-3 py-2 mt-2"
            data-testid="missing-notice"
          >
            {requestedPath.join(' / ')} is not in this document
            {level.selectedKey !== null ? ' (any more)' : ''}.
          </div>
        )}

        {/* Filtered to the subtree on screen, so navigating narrows it. */}
        <ValidationList
          errors={validationErrors}
          path={level.fieldPath ?? level.levelPath}
          onNavigate={navigate}
        />

        {snapshot == null ? null : level.fieldPath ? (
          <FieldScreen
            fieldPath={level.fieldPath}
            text={typeof fieldText === 'string' ? fieldText : ''}
            spans={fieldSpans ?? []}
            editable={editable}
            errors={validationErrors}
            peerFocusedPaths={peerFocusedPaths}
            onOps={handleRichTextOps}
            onSetText={handleSetText}
          />
        ) : isContainer(levelValue) ? (
          <LevelList
            // Keyed to the level, so navigating away drops that level's filter and
            // its "show all" — a new level starts fresh, showing everything in it.
            key={level.levelPath.join('/')}
            levelPath={level.levelPath}
            value={levelValue}
            editable={editable}
            docId={docId}
            richPaths={richPaths}
            markerCounts={markerCounts}
            selectedKey={level.selectedKey}
            changedPaths={changedPaths}
            errors={validationErrors}
            peerFocusedPaths={peerFocusedPaths}
            onPrimary={(t) => {
              if (isContainer(t.value) || t.kind === 'richtext') navigate(t.path);
              else setEditing(t);
            }}
            onDelete={handleDelete}
          />
        ) : (
          <div className="text-sm text-muted-foreground py-4 px-2">
            Failed to load a snapshot for this version.
          </div>
        )}
      </div>

      {/* Adding is the level's own action, so it is the FAB — the same gesture that
          adds a task or a counter. Only on a container: a rich-text field's screen
          has nothing to add a property to. */}
      {editable && !level.fieldPath && isContainer(levelValue) && (
        <Fab
          icon="add"
          aria-label={Array.isArray(levelValue) ? 'Add item' : 'Add property'}
          onClick={() => setAdding(true)}
        />
      )}

      <ValueSheet
        open={!!editing}
        title={`${editable ? 'Edit' : ''} ${String(editing?.key ?? '')}`.trim()}
        label={String(editing?.key ?? 'Value')}
        value={editing
          ? (typeof editing.value === 'string'
              ? escapeString(editing.value)
              : editing.value === null ? 'null' : String(editing.value))
          : ''}
        multiline={typeof editing?.value === 'string' && editing.value.length > 60}
        readOnly={!editable}
        supportingText={editable ? 'null, true, false and numbers are stored as themselves' : undefined}
        onSave={(raw) => { if (editing) handleEdit(editing.path, parseValue(raw)); }}
        onClose={() => setEditing(null)}
      />

      <AddPropertySheet
        open={adding}
        path={level.levelPath}
        isArray={Array.isArray(levelValue)}
        nextIndex={Array.isArray(levelValue) ? levelValue.length : 0}
        onAdd={handleAdd}
        onClose={() => setAdding(false)}
      />

      <ChangesSheet
        open={history.active}
        history={history}
        patches={versionPatches}
        // Write access, not `history.editable` — see ChangesSheet's `canRestore`.
        canRestore={accessCanEdit && !readOnly}
        onClose={history.toggleHistory}
        onNavigate={(path) => { setHistoryOpen(false); navigate(path); }}
      />

      {confirmSheet}
    </>
  );
}
