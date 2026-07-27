import { useState, useEffect, useRef, useMemo, useCallback } from 'preact/hooks';
import { MdTextField } from '@/components/ui/md-text-field';
import { MdSelect } from '@/components/ui/md-select';
import type { Task } from '../../../../shared/schemas/tasks';
import { PropertySheet, SheetActions, SheetActionItem } from '../../common/PropertySheet';
import type { PropertyDef } from '../../common/PropertySheet';
import type { PeerFieldInfo } from '../../common/presence';

interface TaskEditorProps {
  uid: string;
  task: Task;
  isNew: boolean;
  opened: boolean;
  onSave: (uid: string, data: Task) => void;
  onDelete: (uid: string) => void;
  onClose: () => void;
  /** Rapid entry: after saving a NEW task via Enter, reopen a fresh blank one. */
  onAddAnother?: () => void;
  onFieldFocus?: (path: (string | number)[] | null) => void;
  peerFocusedFields?: Record<string, PeerFieldInfo>;
}

const FIELD_TO_PROP: Record<string, string> = {
  'ted-title': 'title',
  'ted-due': 'due',
  'ted-priority': 'priority',
  'ted-progress': 'progress',
  'ted-desc': 'description',
};

const PROGRESS_OPTIONS = [
  { value: 'needs-action', label: 'Needs action' },
  { value: 'in-process', label: 'In process' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
];

export function TaskEditor({ uid, task, isNew, opened, onSave, onDelete, onClose, onAddAnother, onFieldFocus, peerFocusedFields }: TaskEditorProps) {
  const fieldToPath = useMemo(() => {
    const map: Record<string, (string | number)[]> = {};
    for (const [inputId, prop] of Object.entries(FIELD_TO_PROP)) {
      map[inputId] = ['tasks', uid, prop];
    }
    return map;
  }, [uid]);

  const focusField = useCallback((fieldId: string) => {
    if (onFieldFocus && fieldToPath[fieldId]) onFieldFocus(fieldToPath[fieldId]);
  }, [onFieldFocus, fieldToPath]);
  const blurField = useCallback(() => {
    if (onFieldFocus) onFieldFocus(null);
  }, [onFieldFocus]);

  const [title, setTitle] = useState(task.title || '');
  const [due, setDue] = useState(task.due ? task.due.substring(0, 10) : '');
  const [priority, setPriority] = useState(task.priority || 0);
  const [progress, setProgress] = useState(task.progress || 'needs-action');
  const [description, setDescription] = useState(task.description || '');

  const prevTaskRef = useRef(task);
  const prevUidRef = useRef(uid);
  useEffect(() => {
    const prev = prevTaskRef.current;
    const uidChanged = prevUidRef.current !== uid;
    prevTaskRef.current = task;
    prevUidRef.current = uid;
    // Switched to a different task (incl. the fresh blank after Enter-to-add-
    // another): reset every field — the per-field diff below only reacts to
    // remote doc changes and would keep locally-typed values.
    if (uidChanged) {
      setTitle(task.title || '');
      setDue(task.due ? task.due.substring(0, 10) : '');
      setPriority(task.priority || 0);
      setProgress(task.progress || 'needs-action');
      setDescription(task.description || '');
      return;
    }
    if (prev.title !== task.title) setTitle(task.title || '');
    if (prev.due !== task.due) setDue(task.due ? task.due.substring(0, 10) : '');
    if (prev.priority !== task.priority) setPriority(task.priority || 0);
    if (prev.progress !== task.progress) setProgress(task.progress || 'needs-action');
    if (prev.description !== task.description) setDescription(task.description || '');
  }, [uid, task]);

  /**
   * Auto-save: commit the full current field set (with optional not-yet-in-state
   * overrides, e.g. a select's fresh value). Called on field blur/change — there
   * are no Save/Cancel buttons. A NEW task is only created once it has a title,
   * so dismissing an untouched editor never creates anything.
   */
  const commit = (overrides: Partial<Task> = {}) => {
    const effTitle = ((overrides.title ?? title) || '').trim();
    if (isNew && !effTitle) return;
    const updated: any = {
      '@type': 'Task',
      title: effTitle || 'Untitled',
      progress: overrides.progress ?? progress,
    };
    updated.due = (overrides.due ?? due) || undefined;
    updated.priority = (overrides.priority ?? priority) || undefined;
    updated.description = (overrides.description ?? description) || undefined;
    onSave(uid, updated);
  };

  const handleDelete = () => {
    if (!confirm('Delete this task?')) return;
    onDelete(uid);
  };

  const progressLabel = PROGRESS_OPTIONS.find(o => o.value === progress)?.label ?? '';

  const properties: PropertyDef[] = [
    {
      id: 'ted-title',
      label: 'Title',
      icon: 'edit',
      summary: () => title,
      render: ({ back }) => (
        <MdTextField
          label="Title"
          data-testid="ted-title"
          value={title}
          onInput={setTitle}
          onFocus={() => focusField('ted-title')}
          onBlur={blurField}
          onCommit={v => commit({ title: v })}
          onEnter={() => {
            if (!title.trim()) return; // no accidental empty tasks
            commit();
            // Rapid entry: keep the sheet open on a fresh blank task, still in
            // this pane. Editing an existing task instead returns to the list.
            if (isNew) onAddAnother?.();
            else back();
          }}
        />
      ),
    },
    {
      id: 'ted-due',
      label: 'Due date',
      icon: 'event',
      summary: () => due,
      render: () => (
        <MdTextField
          label="Due date"
          type="date"
          data-testid="ted-due"
          value={due}
          onInput={setDue}
          onFocus={() => focusField('ted-due')}
          onBlur={blurField}
          onCommit={v => commit({ due: v })}
        />
      ),
    },
    {
      id: 'ted-priority',
      label: 'Priority',
      icon: 'flag',
      summary: () => (priority ? String(priority) : ''),
      render: () => (
        <MdTextField
          label="Priority"
          type="number"
          min={0}
          max={9}
          data-testid="ted-priority"
          value={String(priority)}
          supportingText="0 = none"
          onInput={v => setPriority(parseInt(v) || 0)}
          onFocus={() => focusField('ted-priority')}
          onBlur={blurField}
          onCommit={v => commit({ priority: parseInt(v) || 0 })}
        />
      ),
    },
    {
      id: 'ted-progress',
      label: 'Progress',
      icon: 'donut_large',
      summary: () => progressLabel,
      render: ({ back }) => (
        <MdSelect
          label="Progress"
          data-testid="ted-progress"
          value={progress}
          options={PROGRESS_OPTIONS}
          // No commit-on-blur: opening the menu blurs the host (see md-select).
          onFocus={() => focusField('ted-progress')}
          onValueChange={v => {
            const next = (v || 'needs-action') as NonNullable<Task['progress']>;
            setProgress(next);
            commit({ progress: next });
            blurField();
            back();
          }}
        />
      ),
    },
    {
      id: 'ted-desc',
      label: 'Description',
      icon: 'notes',
      summary: () => description,
      render: () => (
        <MdTextField
          label="Description"
          type="textarea"
          rows={4}
          data-testid="ted-desc"
          value={description}
          onInput={setDescription}
          onFocus={() => focusField('ted-desc')}
          onBlur={blurField}
          onCommit={v => commit({ description: v })}
        />
      ),
    },
  ];

  return (
    <PropertySheet
      open={opened}
      title={isNew ? 'New Task' : 'Edit Task'}
      data-testid="task-editor"
      properties={properties}
      peerFocusedFields={peerFocusedFields}
      // A blank task has nothing to list, so start in the title field — which is
      // also what makes Enter-to-add-another a continuous flow.
      initialDetailId={isNew ? 'ted-title' : null}
      onClose={onClose}
      flushOnClose
      footer={!isNew ? (
        <SheetActions>
          <SheetActionItem icon="delete" label="Delete" destructive data-testid="ted-delete" onClick={handleDelete} />
        </SheetActions>
      ) : undefined}
    />
  );
}
