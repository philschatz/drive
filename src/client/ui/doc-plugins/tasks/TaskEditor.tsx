import { useState, useEffect, useRef, useMemo, useCallback } from 'preact/hooks';
import { MdTextField } from '@/components/ui/md-text-field';
import { MdSelect } from '@/components/ui/md-select';
import { MdSlider } from '@/components/ui/md-slider';
import { Button } from '@/components/ui/button';
import type { Task } from '../../../../shared/schemas/tasks';
import { PropertySheet, SheetActions, SheetActionItem } from '../../common/PropertySheet';
import type { PropertyDef } from '../../common/PropertySheet';
import { FieldEditor } from '../../common/FieldEditor';
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
   * Commit the full current field set, with optional not-yet-in-state overrides —
   * a pane's Save, or a select's fresh value. A NEW task is only created once it
   * has a title, so dismissing an untouched editor never creates anything.
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
      transactional: true,
      render: ({ back }) => (
        // key={uid}: onAddAnother swaps in a fresh blank task without closing this
        // pane, and a still-mounted FieldEditor would keep the previous draft.
        <FieldEditor
          key={uid}
          data-testid="ted-title"
          value={title}
          validate={v => !!v.trim()} // no accidental empty tasks
          onCancel={back}
          onSave={v => {
            commit({ title: v });
            if (isNew) {
              // Rapid entry: keep the sheet open on a fresh blank task, still in
              // this pane. Clear `title` here rather than leaving it to the
              // per-uid reset effect below — that effect runs *after* the keyed
              // remount, which would seed the new draft from the old title.
              setTitle('');
              onAddAnother?.();
            } else {
              setTitle(v);
              back();
            }
          }}
        >
          {({ value, onInput, save }) => (
            <MdTextField
              label="Title"
              data-testid="ted-title"
              value={value}
              onInput={onInput}
              onFocus={() => focusField('ted-title')}
              onBlur={blurField}
              onEnter={save}
            />
          )}
        </FieldEditor>
      ),
    },
    {
      id: 'ted-due',
      label: 'Due date',
      icon: 'event',
      summary: () => due,
      transactional: true,
      render: ({ back }) => (
        <FieldEditor
          data-testid="ted-due"
          value={due}
          onCancel={back}
          onSave={v => { setDue(v); commit({ due: v }); back(); }}
        >
          {({ value, onInput }) => (
            <MdTextField
              label="Due date"
              type="date"
              data-testid="ted-due"
              value={value}
              onInput={onInput}
              onFocus={() => focusField('ted-due')}
              onBlur={blurField}
            />
          )}
        </FieldEditor>
      ),
    },
    {
      id: 'ted-priority',
      label: 'Priority',
      icon: 'flag',
      summary: () => (priority ? String(priority) : ''),
      transactional: true,
      render: ({ back }) => (
        <FieldEditor
          data-testid="ted-priority"
          // An unset priority seeds the handle at 5 (the midpoint): a 0 draft
          // on a min-1 slider would render the handle at 1 while Save meant
          // "none" — the control would lie about what Save writes.
          value={String(priority || 5)}
          onCancel={back}
          onSave={v => {
            const next = parseInt(v) || 0;
            setPriority(next);
            commit({ priority: next });
            back();
          }}
        >
          {({ value, onInput }) => (
            <>
              <MdSlider
                label="Priority"
                data-testid="ted-priority"
                // PropertySheet's autofocus fallback selector doesn't know
                // md-slider, and the next focusable here is the button below.
                data-autofocus=""
                min={1}
                max={9}
                step={1}
                ticks
                labeled
                value={parseInt(value) || 5}
                supportingText="9 is highest, 1 is lowest"
                onInput={v => onInput(String(v))}
                onFocus={() => focusField('ted-priority')}
                onBlur={blurField}
              />
              <div className="mt-3">
                {/* Clearing bypasses the draft: an immediate commit like the
                    Progress pick (commit maps 0 → field removed). */}
                <Button
                  variant="outline"
                  data-testid="ted-priority-none"
                  onClick={() => { setPriority(0); commit({ priority: 0 }); back(); }}
                >
                  No priority
                </Button>
              </div>
            </>
          )}
        </FieldEditor>
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
      transactional: true,
      render: ({ back }) => (
        <FieldEditor
          data-testid="ted-desc"
          value={description}
          onCancel={back}
          onSave={v => { setDescription(v); commit({ description: v }); back(); }}
        >
          {({ value, onInput }) => (
            <MdTextField
              label="Description"
              type="textarea"
              rows={4}
              data-testid="ted-desc"
              value={value}
              onInput={onInput}
              onFocus={() => focusField('ted-desc')}
              onBlur={blurField}
            />
          )}
        </FieldEditor>
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
      // No flushOnClose: every text pane here is transactional and Progress commits
      // on pick, so there is nothing pending for a blur-on-close to rescue.
      footer={!isNew ? (
        <SheetActions>
          <SheetActionItem icon="delete" label="Delete" destructive data-testid="ted-delete" onClick={handleDelete} />
        </SheetActions>
      ) : undefined}
    />
  );
}
