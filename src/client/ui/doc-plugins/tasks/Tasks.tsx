import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import './tasks.css';
import { subscribeQuery, updateDoc, deepAssign } from '../../worker-api';
import { peerColor, peerDisplayName, usePresence, type PeerFieldInfo } from '../../common/presence';
import { PresenceDot } from '../../common/PeerDot';
import { DocumentTitleBar } from '../../common/DocumentTitleBar';
import { useDocumentHistory } from '../../common/useDocumentHistory';
import { useEditorUndoRedo } from '../../common/useUndoRedo';
import { useCanEdit } from '../../common/useCanEdit';
import { useFocusPathSync } from '../../common/useFocusPathSync';
import { HistorySlider } from '../../common/HistorySlider';
import { ListRow } from '../../common/ListRow';
import type { TaskDocument, Task } from '../../../../shared/schemas/tasks';
import { TaskEditor } from './TaskEditor';
import { useDocumentValidation } from '../../common/useDocumentValidation';
import { DocLoader } from '../../common/useDocument';
import { Badge } from '@/components/ui/badge';
import { Fab } from '@/components/ui/fab';

interface EditorState {
  uid: string;
  task: Task;
  isNew: boolean;
}

const TASKS_QUERY = '{ tasks: (.tasks // {}), name: (.name // "Tasks") }';

const PATH_PROP_TO_FIELDS: Record<string, string[]> = {
  title: ['ted-title'],
  due: ['ted-due'],
  priority: ['ted-priority'],
  progress: ['ted-progress'],
  description: ['ted-desc'],
};

function generateUid() {
  return Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

function sortedTasks(tasks: Record<string, Task>): { uid: string; task: Task }[] {
  const entries = Object.entries(tasks).map(([uid, task]) => ({ uid, task }));
  const incomplete = entries.filter(e => e.task.progress !== 'completed' && e.task.progress !== 'cancelled');
  const done = entries.filter(e => e.task.progress === 'completed' || e.task.progress === 'cancelled');

  const byDueThenUid = (a: { uid: string; task: Task }, b: { uid: string; task: Task }) => {
    const ad = a.task.due || '';
    const bd = b.task.due || '';
    if (ad && !bd) return -1;
    if (!ad && bd) return 1;
    if (ad !== bd) return ad < bd ? -1 : 1;
    return a.uid < b.uid ? -1 : 1;
  };

  incomplete.sort(byDueThenUid);
  done.sort(byDueThenUid);
  return [...incomplete, ...done];
}

/**
 * One task row: tap toggles completion, and the editor is the row's one secondary
 * action — so ListRow gives it a pencil rather than a kebab, and a hold (or
 * right-click, or Shift+F10) opens it. Delete lives inside the editor, not on the
 * row, which is why the count is one and not two.
 */
function TaskListItem({ uid, task, canEdit, peerEditingTasks, onToggle, onEdit }: {
  uid: string;
  task: Task;
  canEdit: boolean;
  peerEditingTasks: Record<string, PeerFieldInfo>;
  onToggle: (uid: string, task: Task) => void;
  onEdit: (uid: string, task: Task) => void;
}) {
  const isDone = task.progress === 'completed' || task.progress === 'cancelled';
  const peerEdit = peerEditingTasks[uid];
  const title = task.title || 'Untitled';

  return (
    // NOTE: @material/web components shim host `role`/`aria-*` attributes into
    // `data-*`, so row semantics can't be set here. The md-checkbox below is the
    // state carrier for AT; the row itself is a button (md-list-item internal).
    <ListRow
      data-checked={isDone ? 'true' : 'false'}
      data-testid="task-row"
      style={{ opacity: peerEdit ? 0.5 : undefined }}
      onTap={canEdit ? () => onToggle(uid, task) : undefined}
      actions={canEdit
        ? [{ icon: 'edit', label: 'Edit', title: `Edit ${title}`, onSelect: () => onEdit(uid, task) }]
        : []}
      end={
        <>
          {task.due && <Badge variant="secondary">{task.due.substring(0, 10)}</Badge>}
          {task.priority ? <Badge variant="default">P{task.priority}</Badge> : null}
          <PresenceDot fieldId={uid} peerFocusedFields={peerEditingTasks} />
        </>
      }
    >
      {/* checked must be a real boolean: Preact skips writing `checked` when the
          value is null/undefined, so `isDone || undefined` would never uncheck.
          Visual + AT state only — the row owns the interaction (tabIndex -1 keeps
          it out of the tab order; pointer-events-none blocks stray clicks). */}
      <md-checkbox
        slot="start"
        checked={isDone}
        disabled={!canEdit}
        tabIndex={-1}
        className="pointer-events-none"
      />
      <div
        slot="headline"
        style={{
          textDecoration: isDone ? 'line-through' : 'none',
          opacity: isDone ? 0.5 : 1,
        }}
      >
        {title}
      </div>
    </ListRow>
  );
}

export function Tasks({ docId, rest, readOnly }: { docId?: string; rest?: string; readOnly?: boolean; path?: string }) {
  const taskId = rest?.startsWith('tasks/') ? rest.slice(6).split('/')[0] : undefined;
  const [listName, setListName] = useState('Tasks');
  const [tasks, setTasks] = useState<Record<string, Task>>({});
  const [editorState, setEditorState] = useState<EditorState | null>(null);

  const history = useDocumentHistory(docId!);
  // Feeds both the version slider and the undo cursor; ref-routed inside the
  // hook so the (docId-only-deps) subscription effect never calls a stale one.
  const { undo, redo, canUndo, canRedo, onHeads } = useEditorUndoRedo(docId!, history);
  const validationErrors = useDocumentValidation(docId);
  const { canEdit, canEditRef, noAccess } = useCanEdit(docId, readOnly, history);
  const { peers, peerList, broadcast } = usePresence(docId);
  const editorStateRef = useRef(editorState);
  editorStateRef.current = editorState;
  const pendingTaskIdRef = useRef(taskId);

  // Auto-save: commits arrive on field blur/change while the editor stays open
  // (dismissing the sheet is the only "done" gesture).
  const saveTask = useCallback((uid: string, taskData: Task) => {
    if (!canEditRef.current || !docId) return;
    updateDoc(docId, (d, deepAssign, uid, taskData) => {
      if (!d.tasks[uid]) {
        const clean: any = {};
        for (const key in taskData) {
          if ((taskData as any)[key] !== undefined) clean[key] = (taskData as any)[key];
        }
        d.tasks[uid] = clean;
      } else {
        deepAssign(d.tasks[uid], taskData);
      }
    }, deepAssign, uid, taskData);
  }, [docId]);

  const deleteTask = useCallback((uid: string) => {
    if (!canEditRef.current || !docId) return;
    updateDoc(docId, (d, uid) => { delete d.tasks[uid]; }, uid);
    setEditorState(null);
  }, [docId]);

  const openEditor = useCallback((uid: string | null, task: Task | null) => {
    const isNew = !uid;
    if (isNew) {
      uid = generateUid();
      task = { '@type': 'Task', title: '', progress: 'needs-action' };
    }
    setEditorState({ uid: uid!, task: task!, isNew });
  }, []);

  const hasCompleted = Object.values(tasks).some(
    t => t.progress === 'completed' || t.progress === 'cancelled',
  );

  const deleteCompleted = useCallback(() => {
    if (!canEditRef.current || !docId) return;
    const uids = Object.entries(tasks)
      .filter(([, t]) => t.progress === 'completed' || t.progress === 'cancelled')
      .map(([uid]) => uid);
    if (uids.length === 0) return;
    updateDoc(docId, (d, uids) => {
      for (const uid of uids) delete d.tasks[uid];
    }, uids);
    const es = editorStateRef.current;
    if (es && uids.includes(es.uid)) setEditorState(null);
  }, [docId, tasks]);

  const toggleComplete = useCallback((uid: string, task: Task) => {
    if (!canEditRef.current || !docId) return;
    const newProgress = task.progress === 'completed' ? 'needs-action' : 'completed';
    updateDoc(docId, (d, uid, newProgress) => { d.tasks[uid].progress = newProgress; }, uid, newProgress);
  }, [docId]);

  // Automerge path to the focused field (drives presence, URL, and Edit Source link)
  const [focusedPath, setFocusedPath] = useState<(string | number)[] | null>(null);
  const focusPath: (string | number)[] | undefined = focusedPath ?? (editorState ? ['tasks', editorState.uid] : undefined);

  const handleFieldFocus = useCallback((path: (string | number)[] | null) => {
    setFocusedPath(path);
  }, []);

  // Clear a stale field focus when the editor closes; sync presence.
  useEffect(() => { if (!editorState) setFocusedPath(null); }, [editorState]);
  useFocusPathSync(focusPath, broadcast);

  const peerFocusedFields = useMemo(() => {
    const result: Record<string, PeerFieldInfo> = {};
    if (!editorState) return result;
    for (const peer of Object.values(peers)) {
      const pf = peer.value?.focusedField;
      if (!pf || pf.length < 3) continue;
      if (pf[0] !== 'tasks' || pf[1] !== editorState.uid) continue;
      const prop = pf[2] as string;
      const inputIds = PATH_PROP_TO_FIELDS[prop];
      if (inputIds) {
        const userGroupId = peer.value?.userGroupId;
        const info = { color: peerColor(peer.peerId, userGroupId), peerId: peer.peerId, userGroupId };
        for (const id of inputIds) result[id] = info;
      }
    }
    return result;
  }, [peers, editorState]);

  useEffect(() => {
    if (!docId) return;

    let mounted = true;

    const unsubscribe = subscribeQuery(docId, TASKS_QUERY, (result, heads) => {
      if (!mounted) return;
      if (!result) return;
      setTasks(result.tasks || {});
      if (result.name) {
        setListName(result.name);
        document.title = result.name + ' - Tasks';
      }
      // Update history tracking + undo cursor
      onHeads(heads);

      // Auto-open task from URL on first load
      if (pendingTaskIdRef.current && result.tasks) {
        const task = result.tasks[pendingTaskIdRef.current];
        if (task) openEditor(pendingTaskIdRef.current, task);
        pendingTaskIdRef.current = undefined;
      }

      // Update open editor if task data changed
      const es = editorStateRef.current;
      if (es && !es.isNew) {
        const fresh = (result.tasks || {})[es.uid];
        if (fresh) {
          setEditorState(prev => {
            if (!prev || prev.uid !== es.uid) return prev;
            return { ...prev, task: fresh };
          });
        } else {
          setEditorState(null);
        }
      }
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [docId]);

  const peerEditingTasks = useMemo(() => {
    const result: Record<string, PeerFieldInfo> = {};
    for (const peer of Object.values(peers)) {
      const pf = peer.value?.focusedField;
      if (pf && pf[0] === 'tasks' && pf[1]) {
        const userGroupId = peer.value?.userGroupId;
        result[pf[1] as string] = { color: peerColor(peer.peerId, userGroupId), peerId: peer.peerId, userGroupId };
      }
    }
    return result;
  }, [peers]);
  const sorted = sortedTasks(tasks);

  return (
    <DocLoader docId={docId}>
    <>
      <DocumentTitleBar
        icon="checklist"
        title={listName}
        titleEditable={canEdit}
        onRename={(value) => {
          if (!docId || !canEdit) return;
          const name = value.trim() || 'Tasks';
          setListName(name);
          updateDoc(docId, (d, name) => { d.name = name; }, name);
          document.title = name + ' - Tasks';
        }}
        docId={docId}
        peers={peerList}
        peerTitle={(peer) => `${peerDisplayName(peer.peerId, peer.value?.userGroupId)}${peer.value?.focusedField ? ' (editing)' : ''}`}
        onToggleHistory={history.toggleHistory}
        historyActive={history.active}
        onUndo={canEdit ? undo : undefined}
        onRedo={canEdit ? redo : undefined}
        canUndo={canUndo}
        canRedo={canRedo}
        hasValidationErrors={validationErrors.length > 0}
        sourcePath={focusPath}
        // Only offered when there's something finished to clear out.
        action={canEdit && hasCompleted ? {
          icon: 'delete_sweep',
          label: 'Delete completed',
          onSelect: () => {
            // Bulk destructive action — confirm before wiping.
            if (!window.confirm('Delete all completed tasks?')) return;
            deleteCompleted();
          },
        } : undefined}
      />
      <HistorySlider history={history} />
      <div
        className="max-w-screen-md mx-auto w-full px-2 sm:px-4 pb-28"
        style={noAccess ? { opacity: 0.4, pointerEvents: 'none' } : undefined}
      >

      <md-list style={{ background: 'transparent' }}>
        {sorted.map(({ uid, task }) => (
          <TaskListItem
            key={uid}
            uid={uid}
            task={task}
            canEdit={canEdit}
            peerEditingTasks={peerEditingTasks}
            onToggle={toggleComplete}
            onEdit={openEditor}
          />
        ))}
      </md-list>
      {sorted.length === 0 && (
        <p className="text-sm text-muted-foreground py-4">No tasks yet.</p>
      )}

      </div>

      {canEdit && (
        <Fab icon="add" aria-label="New task" onClick={() => openEditor(null, null)} />
      )}

      <TaskEditor
        uid={editorState?.uid || ''}
        task={editorState?.task || { '@type': 'Task', title: '', progress: 'needs-action' }}
        isNew={editorState?.isNew || false}
        opened={!!editorState}
        onSave={saveTask}
        onDelete={deleteTask}
        onClose={() => setEditorState(null)}
        onAddAnother={() => openEditor(null, null)}
        onFieldFocus={handleFieldFocus}
        peerFocusedFields={peerFocusedFields}
      />

    </>
    </DocLoader>
  );
}
