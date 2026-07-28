import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import './sentences.css';
import {
  subscribeQuery, updateDoc, richText, getTextCursors, subscribeCursors,
  getWorkerPeerId, getWorkerUserGroupId,
  type RichTextOp, type RichTextSpan,
} from '../../worker-api';
import { peerColor, peerDisplayName, peerIdentityKey, usePresence } from '../../common/presence';
import { DocumentTitleBar } from '../../common/DocumentTitleBar';
import { useDocumentHistory } from '../../common/useDocumentHistory';
import { useEditorUndoRedo } from '../../common/useUndoRedo';
import { useHideOnScroll } from '../../common/useHideOnScroll';
import { useCanEdit } from '../../common/useCanEdit';
import { useFocusPathSync } from '../../common/useFocusPathSync';
import { useKeyboardInset } from '../../common/useKeyboardInset';
import { useDocumentValidation } from '../../common/useDocumentValidation';
import { HistorySlider } from '../../common/HistorySlider';
import { DocLoader } from '../../common/useDocument';
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
  const editorApiRef = useRef<RichTextEditorApi | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  // While local writes are in flight, subscription pushes lag the optimistic
  // state (each echoes ops 1..n while we're at n+k) — applying one would snap
  // the text backwards mid-typing. Skip them and apply the last one when the
  // writes drain (it then equals the optimistic state, plus any remote merge).
  const pendingWritesRef = useRef(0);
  const skippedSpansRef = useRef<RichTextSpan[] | null>(null);
  const skippedCursorsRef = useRef<Record<string, number | null> | undefined>(undefined);
  // Registered cursor tokens → their position in the spans currently in state.
  // Delivered by the same push as the spans, which is what lets a peer caret be
  // drawn (and the local caret rebased) against exactly the text being rendered.
  const [cursorPositions, setCursorPositions] = useState<Record<string, number | null> | undefined>(undefined);

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

  /**
   * Apply a push from the worker. The caret rebase lands BEFORE setSpans on
   * purpose: the editor's restore effect runs on the spans render, so text
   * rendered against a stale caret index would make the next keystroke splice at
   * the wrong offset. Nothing can interleave between the two calls.
   */
  const applyRemoteSpans = useCallback((next: RichTextSpan[], cursors?: Record<string, number | null>) => {
    const held = localCursorRef.current;
    const api = editorApiRef.current;
    // localCursorRef is only populated in edit mode, and isFocused() keeps an
    // unfocused editor from claiming a caret it doesn't own.
    if (held && cursors && api?.isFocused()) {
      const from = cursors[held.tokens[0]];
      const to = cursors[held.tokens[1]];
      if (typeof from === 'number' && typeof to === 'number') {
        const sel = { from: Math.min(from, to), to: Math.max(from, to) };
        // The tokens still point at the same characters, so re-key them to the
        // rebased selection rather than re-minting — back-to-back remote pushes
        // then each get rebased instead of tripping the staleness guard.
        if (api.rebaseCaret(held.sel, sel)) localCursorRef.current = { tokens: held.tokens, sel };
      }
    }
    setSpans(next);
    setCursorPositions(cursors);
  }, []);

  useEffect(() => {
    if (!docId) return;
    let mounted = true;
    const unsubscribe = subscribeQuery(docId, DOC_QUERY, (result, heads, _lastModified, docSpans, cursors) => {
      if (!mounted || !result) return;
      if (pendingWritesRef.current > 0) {
        skippedSpansRef.current = docSpans ?? [];
        skippedCursorsRef.current = cursors;
      } else {
        applyRemoteSpans(docSpans ?? [], cursors);
      }
      onHeads(heads);
      if (result.name) {
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
          const c = skippedCursorsRef.current;
          skippedSpansRef.current = null;
          skippedCursorsRef.current = undefined;
          applyRemoteSpans(s, c);
        }
      });
  }, [docId, applyRemoteSpans]);

  // ── Cursors (Peritext convention) ─────────────────────────────────────────
  // Carets travel as Automerge Cursor tokens, not indices — a cursor keeps
  // pointing at the same character across concurrent edits. The local caret is
  // broadcast in `focusedField` as ['content', fromToken, toToken]; peers'
  // tokens arrive the same way.
  //
  // Minting a token is the only round trip, and it happens when the caret
  // MOVES. Resolving tokens back to indices is registered with the worker
  // (subscribeCursors) and rides the spans push, so every position arrives in
  // the same message as the text it describes. Requests are FIFO behind our own
  // updateDoc calls, so a token is minted against a doc that already includes
  // the selection's optimistic edits.
  const [cursorPath, setCursorPath] = useState<(string | number)[] | null>(null);
  // Which selection the current tokens describe. If the user types past it
  // before the mint returns, a resolution from those tokens describes an older
  // caret — the editor's rebaseCaret guard refuses it.
  const localCursorRef = useRef<{ tokens: [string, string]; sel: { from: number; to: number } } | null>(null);
  useEffect(() => {
    if (!docId || !editMode || !selState) {
      localCursorRef.current = null;
      setCursorPath(null);
      return;
    }
    let cancelled = false;
    const sel = { from: selState.from, to: selState.to };
    getTextCursors(docId, ['content'], [sel.from, sel.to])
      .then(([from, to]) => {
        if (cancelled) return;
        localCursorRef.current = { tokens: [from, to], sel };
        setCursorPath(['content', from, to]);
      })
      .catch(() => { /* doc not ready — next selection change retries */ });
    return () => { cancelled = true; };
  }, [docId, editMode, selState?.from, selState?.to]);

  useFocusPathSync(editMode ? (cursorPath ?? ['content']) : null, broadcast);

  // Peers whose presence carries a cursor pair, one entry per user (a user's
  // several devices collapse to one identity; own devices are skipped). Derived
  // synchronously — only the token→index resolution needs the worker.
  const peerCursors = useMemo(() => {
    const myPeerId = getWorkerPeerId();
    const myGroup = getWorkerUserGroupId();
    const seen = new Set<string>();
    const out: { id: string; color: string; label: string; from: string; to: string }[] = [];
    for (const peer of Object.values(peers)) {
      if (myPeerId && peer.peerId === myPeerId) continue;
      const ug = peer.value?.userGroupId;
      if (myGroup && ug === myGroup) continue;
      const pf = peer.value?.focusedField;
      if (!pf || pf.length !== 3 || pf[0] !== 'content' || typeof pf[1] !== 'string' || typeof pf[2] !== 'string') continue;
      const id = peerIdentityKey(peer.peerId, ug);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, color: peerColor(peer.peerId, ug), label: peerDisplayName(peer.peerId, ug), from: pf[1], to: pf[2] });
    }
    return out;
  }, [peers]);

  // Register every token we need resolved: the peers' (to draw their carets) and
  // our own (so a concurrent remote edit rebases our caret before its spans
  // render). Keyed on the token strings, so this only fires when the set changes.
  const trackedTokens = useMemo(
    () => [...peerCursors.flatMap(e => [e.from, e.to]), ...(cursorPath?.slice(1) as string[] ?? [])],
    [peerCursors, cursorPath],
  );
  const trackedKey = trackedTokens.join(',');
  useEffect(() => {
    if (!docId) return;
    // A replacing set, so no cleanup between changes — clearing and re-adding on
    // every caret move would blink every peer caret off and back on.
    subscribeCursors(docId, ['content'], trackedTokens);
  }, [docId, trackedKey]);
  // Drop the registration only when leaving the document.
  useEffect(() => {
    if (!docId) return;
    return () => { subscribeCursors(docId, ['content'], []); };
  }, [docId]);

  // Peer carets, built by looking their tokens up in the positions delivered
  // with the spans (see the subscription below) — no request, no extra render.
  const remoteCursors = useMemo<RemoteCursor[]>(() => {
    if (!cursorPositions) return [];
    const out: RemoteCursor[] = [];
    for (const e of peerCursors) {
      const from = cursorPositions[e.from];
      const to = cursorPositions[e.to];
      if (typeof from === 'number' && typeof to === 'number') {
        out.push({ id: e.id, from, to, color: e.color, label: e.label });
      }
    }
    return out;
  }, [peerCursors, cursorPositions]);

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
        onRename={(value) => {
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
