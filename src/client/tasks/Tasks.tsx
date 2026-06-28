import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import './tasks.css';
import { subscribeQuery, updateDoc, deepAssign } from '../worker-api';
import type { PeerState } from '../shared/automerge';
import { peerColor, peerDisplayName, initPresence, type PresenceState, type PeerFieldInfo } from '../shared/presence';
import { EditorTitleBar } from '../shared/EditorTitleBar';
import { useDocumentHistory } from '../shared/useDocumentHistory';
import { useAccess } from '../shared/useAccess';
import { HistorySlider } from '../shared/HistorySlider';
import type { TaskDocument, Task } from './schema';
import { TaskEditor } from './TaskEditor';
import { useDocumentValidation } from '../shared/useDocumentValidation';
import { ValidationPanel } from '../shared/ValidationPanel';
import { DocLoader } from '../shared/useDocument';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';

interface EditorState {
  uid: string;
  task: Task;
  isNew: boolean;
}

const TASKS_QUERY = '{ tasks: (.tasks // {}), name: (.name // "Tasks"), description: (.description // "") }';

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

export function Tasks({ docId, rest, readOnly }: { docId?: string; rest?: string; readOnly?: boolean; path?: string }) {
  const taskId = rest?.startsWith('tasks/') ? rest.slice(6).split('/')[0] : undefined;
  const [listName, setListName] = useState('Tasks');
  const [listDesc, setListDesc] = useState('');
  const [tasks, setTasks] = useState<Record<string, Task>>({});
  const [editorState, setEditorState] = useState<EditorState | null>(null);
  const [peerStates, setPeerStates] = useState<Record<string, PeerState<PresenceState>>>({});
  const [quickAddText, setQuickAddText] = useState('');
  const [showValidation, setShowValidation] = useState(false);

  const history = useDocumentHistory(docId!);
  const validationErrors = useDocumentValidation(docId);
  const { access, canEdit: accessCanEdit, loaded: accessLoaded } = useAccess(docId);
  const canEdit = !readOnly && history.editable && accessCanEdit;
  const noAccess = accessLoaded && access === null;
  const canEditRef = useRef(canEdit);
  canEditRef.current = canEdit;
  const broadcastRef = useRef<((key: keyof PresenceState, value: any) => void) | null>(null);
  const presenceCleanupRef = useRef<(() => void) | null>(null);
  const editorStateRef = useRef(editorState);
  editorStateRef.current = editorState;
  const titleFocusedRef = useRef(false);
  const descFocusedRef = useRef(false);
  const quickAddRef = useRef<HTMLInputElement>(null);
  const pendingTaskIdRef = useRef(taskId);

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
    setEditorState(null);
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

  const handleQuickAdd = useCallback(() => {
    const title = quickAddText.trim();
    if (!title) return;
    const uid = generateUid();
    const task: Task = { '@type': 'Task', title, progress: 'needs-action' };
    saveTask(uid, task);
    setQuickAddText('');
  }, [quickAddText, saveTask]);

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

  // Sync selection → presence broadcast + URL (all derived from focusPath)
  useEffect(() => {
    if (!editorState) setFocusedPath(null);
    broadcastRef.current?.('focusedField', focusPath ?? null);
    const base = window.location.href.split('#')[0];
    if (focusPath) {
      window.history.replaceState(null, '', `${base}#/tasks/${docId}/${focusPath.map(s => encodeURIComponent(String(s))).join('/')}`);
    } else if (docId) {
      window.history.replaceState(null, '', `${base}#/tasks/${docId}`);
    }
  }, [editorState, focusPath, docId]);

  const peerFocusedFields = useMemo(() => {
    const result: Record<string, PeerFieldInfo> = {};
    if (!editorState) return result;
    for (const peer of Object.values(peerStates)) {
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
  }, [peerStates, editorState]);

  useEffect(() => {
    if (!docId) return;

    let mounted = true;

    const { broadcast, cleanup: presenceCleanup } = initPresence<PresenceState>(
      docId,
      () => ({ viewing: true, focusedField: null }),
      (states) => { if (mounted) setPeerStates(states); },
    );
    broadcastRef.current = broadcast;
    presenceCleanupRef.current = presenceCleanup;

    const unsubscribe = subscribeQuery(docId, TASKS_QUERY, (result, heads) => {
      if (!mounted) return;
      if (!result) return;
      setTasks(result.tasks || {});
      if (result.name && !titleFocusedRef.current) {
        setListName(result.name);
        document.title = result.name + ' - Tasks';
      }
      if (!descFocusedRef.current) setListDesc(result.description || '');
      // Update history tracking
      history.onNewHeads(heads);

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
      presenceCleanupRef.current?.();
      broadcastRef.current = null;
      presenceCleanupRef.current = null;
      unsubscribe();
    };
  }, [docId]);

  const peerList = Object.values(peerStates).filter(p => p.value?.viewing);
  const peerEditingTasks = useMemo(() => {
    const result: Record<string, PeerFieldInfo> = {};
    for (const peer of Object.values(peerStates)) {
      const pf = peer.value?.focusedField;
      if (pf && pf[0] === 'tasks' && pf[1]) {
        const userGroupId = peer.value?.userGroupId;
        result[pf[1] as string] = { color: peerColor(peer.peerId, userGroupId), peerId: peer.peerId, userGroupId };
      }
    }
    return result;
  }, [peerStates]);
  const sorted = sortedTasks(tasks);

  return (
    <DocLoader docId={docId}>
    <>
      <EditorTitleBar
        icon="checklist"
        title={listName}
        titleEditable={canEdit}
        onTitleFocus={() => { titleFocusedRef.current = true; }}
        onTitleChange={setListName}
        onTitleBlur={(value) => {
          titleFocusedRef.current = false;
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
        onToggleValidation={() => setShowValidation(v => !v)}
        validationActive={showValidation}
        validationCount={validationErrors.length}
        sourcePath={focusPath}
      />
      <HistorySlider history={history} />
      <div style={noAccess ? { opacity: 0.4, pointerEvents: 'none' } : undefined}>
      <input
        className="border-0 bg-transparent text-sm text-muted-foreground outline-none w-full"
        placeholder="Add a description..."
        value={listDesc}
        onFocus={() => { descFocusedRef.current = true; }}
        onInput={(e: any) => setListDesc(e.currentTarget.value)}
        readOnly={!canEdit}
        onBlur={(e: any) => {
          descFocusedRef.current = false;
          if (!docId || !canEdit) return;
          const desc = e.currentTarget.value.trim();
          setListDesc(desc);
          updateDoc(docId, (d, desc) => { d.description = desc || undefined; }, desc);
        }}
        onKeyDown={(e: any) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      />
      {showValidation && <ValidationPanel errors={validationErrors} docId={docId} docType="TaskList" />}
      {canEdit && (
      <div className="flex items-center gap-2 mb-3">
        <Input
          ref={quickAddRef}
          autoFocus
          placeholder="Add a task..."
          value={quickAddText}
          onInput={(e: any) => setQuickAddText(e.currentTarget.value)}
          onKeyDown={(e: any) => { if (e.key === 'Enter') handleQuickAdd(); }}
          className="flex-1"
        />
        <Button onClick={handleQuickAdd}>Add</Button>
        <Button variant="outline" className="text-destructive" onClick={deleteCompleted}>Delete Completed</Button>
      </div>
      )}

      <div className="flex flex-col">
        {sorted.map(({ uid, task }) => {
          const isDone = task.progress === 'completed' || task.progress === 'cancelled';
          const peerEdit = peerEditingTasks[uid];
          return (
            <div
              key={uid}
              className="flex items-center gap-2 py-1 px-1 flex-nowrap border-b border-border"
              style={{ cursor: 'default', opacity: peerEdit ? 0.5 : undefined }}
            >
              <Checkbox
                checked={isDone}
                disabled={!canEdit}
                onCheckedChange={() => toggleComplete(uid, task)}
              />
              <span
                className="text-sm flex-1 cursor-pointer"
                style={{
                  textDecoration: isDone ? 'line-through' : 'none',
                  opacity: isDone ? 0.5 : 1,
                }}
                onClick={() => openEditor(uid, task)}
              >
                {task.title || 'Untitled'}
              </span>
              {task.due && <Badge variant="secondary">{task.due.substring(0, 10)}</Badge>}
              {task.priority ? <Badge variant="default" className="bg-pink-500">P{task.priority}</Badge> : null}
              {peerEdit && (
                <div
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: peerEdit.color }}
                  title={`Peer ${peerEdit.peerId.slice(0, 8)} is editing`}
                />
              )}
            </div>
          );
        })}
        {sorted.length === 0 && (
          <p className="text-sm text-muted-foreground py-4">No tasks yet. Add one above.</p>
        )}
      </div>

      </div>

      <TaskEditor
        uid={editorState?.uid || ''}
        task={editorState?.task || { '@type': 'Task', title: '', progress: 'needs-action' }}
        isNew={editorState?.isNew || false}
        opened={!!editorState}
        onSave={saveTask}
        onDelete={deleteTask}
        onClose={() => setEditorState(null)}
        onFieldFocus={handleFieldFocus}
        peerFocusedFields={peerFocusedFields}
      />

    </>
    </DocLoader>
  );
}
