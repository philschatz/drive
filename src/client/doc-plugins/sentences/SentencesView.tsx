import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import './sentences.css';
import {
  subscribeQuery, updateDoc, richText, getTextCursors, getTextCursorPositions,
  getWorkerPeerId, getWorkerUserGroupId,
  type RichTextOp, type RichTextSpan,
} from '../../worker-api';
import { peerColor, peerDisplayName, peerIdentityKey, usePresence } from '../../shared/presence';
import { DocumentTitleBar } from '../../shared/DocumentTitleBar';
import { useDocumentHistory } from '../../shared/useDocumentHistory';
import { useEditorUndoRedo } from '../../shared/useUndoRedo';
import { useHideOnScroll } from '../../shared/useHideOnScroll';
import { useCanEdit } from '../../shared/useCanEdit';
import { useFocusPathSync } from '../../shared/useFocusPathSync';
import { useKeyboardInset } from '../../shared/useKeyboardInset';
import { useDocumentValidation } from '../../shared/useDocumentValidation';
import { HistorySlider } from '../../shared/HistorySlider';
import { DocLoader } from '../../shared/useDocument';
import { Fab } from '@/components/ui/fab';
import { RichTextEditor, type RemoteCursor, type RichTextEditorApi, type SelectionState } from './RichTextEditor';
import { BottomFormatBar } from './BottomFormatBar';
import { applyOpsToSpans } from './spans-model';
import { markdownToSpans, spansToMarkdown } from './markdown';

const DOC_QUERY = '{ name: (.name // "Sentences") }';

/**
 * Sentences (word-processing) editor. Opens as a read-only view; the bottom-right
 * FAB (edit role only) switches to edit mode, where the shared title bar gains
 * undo/redo and a DataGrid-style formatting bar docks to the bottom.
 */
export function SentencesView({ docId, readOnly }: { docId?: string; rest?: string; readOnly?: boolean }) {
  const [name, setName] = useState('Sentences');
  const [spans, setSpans] = useState<RichTextSpan[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [selState, setSelState] = useState<SelectionState | null>(null);

  const history = useDocumentHistory(docId!);
  const { undo, redo, canUndo, canRedo, onHeads } = useEditorUndoRedo(docId!, history);
  const hidden = useHideOnScroll();
  const validationErrors = useDocumentValidation(docId);
  const { canEdit, canEditRef, noAccess } = useCanEdit(docId, readOnly, history);
  const { peers, peerList, broadcast } = usePresence(docId);
  const keyboardInset = useKeyboardInset();
  const titleFocusedRef = useRef(false);
  const editorApiRef = useRef<RichTextEditorApi | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  // While local writes are in flight, subscription pushes lag the optimistic
  // state (each echoes ops 1..n while we're at n+k) — applying one would snap
  // the text backwards mid-typing. Skip them and apply the last one when the
  // writes drain (it then equals the optimistic state, plus any remote merge).
  const pendingWritesRef = useRef(0);
  const skippedSpansRef = useRef<RichTextSpan[] | null>(null);

  // Losing edit rights (revocation, time travel) drops back to the viewer.
  const editMode = editing && canEdit;
  useEffect(() => { if (editing && !canEdit) setEditing(false); }, [editing, canEdit]);

  const startEditing = useCallback(() => {
    setEditing(true);
    // Focus once the contenteditable render lands. The browser selection the
    // gesture made (e.g. the double-clicked word) survives the flip, so the
    // caret is already where the user aimed.
    requestAnimationFrame(() => editorApiRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!docId) return;
    let mounted = true;
    const unsubscribe = subscribeQuery(docId, DOC_QUERY, (result, heads, _lastModified, docSpans) => {
      if (!mounted || !result) return;
      if (pendingWritesRef.current > 0) skippedSpansRef.current = docSpans ?? [];
      else setSpans(docSpans ?? []);
      onHeads(heads);
      if (result.name && !titleFocusedRef.current) {
        setName(result.name);
        document.title = result.name + ' - Sentences';
      }
    }, undefined, { spansPath: ['content'] });
    return () => { mounted = false; unsubscribe(); };
  }, [docId]);

  // Optimistic local echo + the real write. The subscription push that follows
  // carries the same (merged) state and simply replaces the local spans.
  const applyOps = useCallback((ops: RichTextOp[]) => {
    if (!canEditRef.current || !docId) return;
    setSpans(prev => applyOpsToSpans(prev ?? [], ops));
    pendingWritesRef.current++;
    updateDoc(docId, (d, richText, ops) => { richText(d, ['content'], ops); }, richText, ops)
      .finally(() => {
        pendingWritesRef.current--;
        if (pendingWritesRef.current === 0 && skippedSpansRef.current) {
          const s = skippedSpansRef.current;
          skippedSpansRef.current = null;
          setSpans(s);
        }
      });
  }, [docId]);

  // ── Cursor presence (Peritext convention) ─────────────────────────────────
  // The local caret is broadcast in `focusedField` as ['content', from, to]
  // where from/to are Automerge Cursors, not indices — a cursor keeps pointing
  // at the same character across concurrent edits, so peers render it in the
  // right place even while both sides type. Conversion runs in the worker
  // (the doc lives there); requests are FIFO behind our own updateDoc calls,
  // so the cursors are computed against a doc that includes the selection's
  // optimistic edits.
  const [cursorPath, setCursorPath] = useState<(string | number)[] | null>(null);
  useEffect(() => {
    if (!docId || !editMode || !selState) { setCursorPath(null); return; }
    let cancelled = false;
    getTextCursors(docId, ['content'], [selState.from, selState.to])
      .then(([from, to]) => { if (!cancelled) setCursorPath(['content', from, to]); })
      .catch(() => { /* doc not ready — next selection change retries */ });
    return () => { cancelled = true; };
  }, [docId, editMode, selState?.from, selState?.to]);

  useFocusPathSync(docId, editMode ? ['content'] : undefined, broadcast, {
    presencePath: editMode ? (cursorPath ?? ['content']) : null,
  });

  // Peers' cursors → indices (re-resolved when peers broadcast or the doc
  // changes, so the lines track surrounding edits) → colored carets in the
  // editor. One caret per user; the local user's own devices are skipped.
  const [remoteCursors, setRemoteCursors] = useState<RemoteCursor[]>([]);
  useEffect(() => {
    if (!docId) return;
    const myPeerId = getWorkerPeerId();
    const myGroup = getWorkerUserGroupId();
    const seen = new Set<string>();
    const entries: { id: string; color: string; label: string; from: string; to: string }[] = [];
    for (const peer of Object.values(peers)) {
      if (myPeerId && peer.peerId === myPeerId) continue;
      const ug = peer.value?.userGroupId;
      if (myGroup && ug === myGroup) continue;
      const pf = peer.value?.focusedField;
      if (!pf || pf.length !== 3 || pf[0] !== 'content' || typeof pf[1] !== 'string' || typeof pf[2] !== 'string') continue;
      const id = peerIdentityKey(peer.peerId, ug);
      if (seen.has(id)) continue;
      seen.add(id);
      entries.push({ id, color: peerColor(peer.peerId, ug), label: peerDisplayName(peer.peerId, ug), from: pf[1], to: pf[2] });
    }
    if (entries.length === 0) {
      setRemoteCursors(prev => (prev.length > 0 ? [] : prev));
      return;
    }
    let cancelled = false;
    getTextCursorPositions(docId, ['content'], entries.flatMap(e => [e.from, e.to]))
      .then(positions => {
        if (cancelled) return;
        const out: RemoteCursor[] = [];
        entries.forEach((e, i) => {
          const from = positions[i * 2];
          const to = positions[i * 2 + 1];
          if (typeof from === 'number' && typeof to === 'number') {
            out.push({ id: e.id, from, to, color: e.color, label: e.label });
          }
        });
        setRemoteCursors(out);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [docId, peers, spans]);

  // Import: replace the document body with the parsed Markdown. One updateSpans
  // op — the worker diffs minimally, and a single change means one undo step.
  const importMarkdown = useCallback(async (file: File) => {
    // FileReader over File.text() — the latter is missing in jsdom.
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
    const hasContent = (spans ?? []).some(s => s.type === 'block' || s.value.length > 0);
    if (hasContent && !window.confirm('Replace the document contents with the imported Markdown?')) return;
    applyOps([{ op: 'updateSpans', spans: markdownToSpans(text) }]);
  }, [spans, applyOps]);

  const overflow = [
    ...(canEdit ? [{
      icon: 'upload_file',
      label: 'Import Markdown',
      onSelect: () => importInputRef.current?.click(),
    }] : []),
    {
      icon: 'markdown_copy',
      label: 'Copy as Markdown',
      onSelect: () => { void navigator.clipboard?.writeText(spansToMarkdown(spans ?? [])); },
    },
  ];

  return (
    <DocLoader docId={docId}>
      <DocumentTitleBar
        icon="description"
        title={name}
        titleEditable={canEdit}
        onTitleFocus={() => { titleFocusedRef.current = true; }}
        onTitleChange={setName}
        onTitleBlur={(value) => {
          titleFocusedRef.current = false;
          if (!docId || !canEdit) return;
          const next = value.trim() || 'Sentences';
          setName(next);
          updateDoc(docId, (d, next) => { d.name = next; }, next);
          document.title = next + ' - Sentences';
        }}
        docId={docId}
        peers={peerList}
        peerTitle={(peer) => `${peerDisplayName(peer.peerId, peer.value?.userGroupId)}${peer.value?.focusedField ? ' (editing)' : ''}`}
        onToggleHistory={history.toggleHistory}
        historyActive={history.active}
        onUndo={editMode ? undo : undefined}
        onRedo={editMode ? redo : undefined}
        canUndo={canUndo}
        canRedo={canRedo}
        // In edit mode the leading button becomes a checkmark that leaves edit
        // mode, the same affordance DataGrid's focus bar uses.
        onDone={editMode ? () => setEditing(false) : undefined}
        hidden={hidden && !editMode}
        hasValidationErrors={validationErrors.length > 0}
        sourcePath={['content']}
        overflow={overflow}
      />
      {/* Hidden picker behind the "Import Markdown" overflow action. */}
      <input
        ref={importInputRef}
        type="file"
        accept=".md,.markdown,.txt,text/markdown,text/plain"
        className="hidden"
        data-testid="import-md-input"
        onChange={(e: any) => {
          const file: File | undefined = e.currentTarget.files?.[0];
          e.currentTarget.value = ''; // allow re-importing the same file
          if (file) void importMarkdown(file);
        }}
      />
      <HistorySlider history={history} />

      <div
        className="max-w-screen-md mx-auto w-full px-4 sm:px-6"
        style={{
          paddingBottom: editMode ? `calc(6rem + ${keyboardInset}px)` : '6rem',
          ...(noAccess ? { opacity: 0.4, pointerEvents: 'none' } : {}),
        }}
        // Double-clicking the viewed text starts editing (links keep their
        // own double-click meaning — opening the target).
        onDblClick={canEdit && !editMode ? (e: MouseEvent) => {
          if ((e.target as Element | null)?.closest?.('a')) return;
          startEditing();
        } : undefined}
      >
        {spans !== null && (
          <RichTextEditor
            spans={spans}
            editable={editMode}
            onOps={applyOps}
            onSelectionState={setSelState}
            onUndo={undo}
            onRedo={redo}
            apiRef={editorApiRef}
            remoteCursors={remoteCursors}
          />
        )}
      </div>

      {canEdit && !editMode && (
        <Fab icon="edit" aria-label="Edit sentences" onClick={startEditing} />
      )}
      {/* Leaving edit mode is the title bar's checkmark (see onDone above), so
          the only thing edit mode adds down here is the formatting bar. */}
      {editMode && (
        <BottomFormatBar state={selState} apiRef={editorApiRef} keyboardInset={keyboardInset} />
      )}
    </DocLoader>
  );
}
