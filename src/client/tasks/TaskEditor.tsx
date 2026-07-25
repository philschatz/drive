import { useState, useEffect, useRef, useMemo, useCallback } from 'preact/hooks';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import type { Task } from './schema';
import { PresenceDot } from '../shared/presence';
import type { PeerFieldInfo } from '../shared/presence';

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

  // Focus the title whenever the editor opens or moves to another task
  // (including the fresh blank task after Enter-to-add-another). The `autofocus`
  // attribute is unreliable in dynamically-mounted DOM, and the Sheet focuses
  // its container only when no child took focus.
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (opened) titleRef.current?.focus();
  }, [opened, uid]);

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

  const pd = (id: string) => <PresenceDot fieldId={id} peerFocusedFields={peerFocusedFields} />;
  const peerOpacity = (id: string) => peerFocusedFields?.[id] ? 0.5 : undefined;

  /**
   * Auto-save: commit the full current field set (with optional not-yet-in-state
   * overrides, e.g. a Select's fresh value). Called on field blur/change — there
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

  return (
    <Sheet open={opened} onOpenChange={(open: boolean) => { if (!open) onClose(); }}>
      <SheetContent side="bottom" className="max-h-[85vh]">
        <SheetHeader>
          <SheetTitle>{isNew ? 'New Task' : 'Edit Task'}</SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-3 mt-4">
          <div style={{ opacity: peerOpacity('ted-title') }}>
            <Label className="flex items-center gap-1"><span>Title</span>{pd('ted-title')}</Label>
            <Input
              ref={titleRef}
              data-testid="ted-title"
              value={title}
              onInput={(e: any) => setTitle(e.currentTarget.value)}
              onFocus={() => focusField('ted-title')}
              onBlur={(e: any) => {
                blurField();
                commit({ title: e.currentTarget.value });
              }}
              onKeyDown={(e: any) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                if (!title.trim()) return; // no accidental empty tasks
                commit();
                // Rapid entry: keep the sheet open on a fresh blank task.
                if (isNew) onAddAnother?.();
              }}
            />
          </div>

          <div style={{ opacity: peerOpacity('ted-due') }}>
            <Label className="flex items-center gap-1"><span>Due date</span>{pd('ted-due')}</Label>
            <Input
              type="date"
              value={due}
              onInput={(e: any) => setDue(e.currentTarget.value)}
              onChange={(e: any) => commit({ due: e.currentTarget.value })}
              onFocus={() => focusField('ted-due')}
              onBlur={blurField}
            />
          </div>

          <div style={{ opacity: peerOpacity('ted-priority') }}>
            <Label className="flex items-center gap-1"><span>Priority (0 = none)</span>{pd('ted-priority')}</Label>
            <Input
              type="number"
              min={0}
              max={9}
              value={String(priority)}
              onInput={(e: any) => setPriority(parseInt(e.currentTarget.value) || 0)}
              onFocus={() => focusField('ted-priority')}
              onBlur={(e: any) => {
                blurField();
                commit({ priority: parseInt(e.currentTarget.value) || 0 });
              }}
            />
          </div>

          <div style={{ opacity: peerOpacity('ted-progress') }}>
            <Label className="flex items-center gap-1"><span>Progress</span>{pd('ted-progress')}</Label>
            <Select
              value={progress}
              onValueChange={(v: string) => {
                const next = (v || 'needs-action') as NonNullable<Task['progress']>;
                setProgress(next);
                commit({ progress: next });
              }}
            >
              <SelectTrigger
                onFocus={() => focusField('ted-progress')}
                onBlur={blurField}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROGRESS_OPTIONS.map(o => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div style={{ opacity: peerOpacity('ted-desc') }}>
            <Label className="flex items-center gap-1"><span>Description</span>{pd('ted-desc')}</Label>
            <Textarea
              value={description}
              onInput={(e: any) => setDescription(e.currentTarget.value)}
              onFocus={() => focusField('ted-desc')}
              onBlur={(e: any) => {
                blurField();
                commit({ description: e.currentTarget.value });
              }}
              rows={3}
            />
          </div>

          {/* Auto-save: fields commit on blur/change — no Save/Cancel. */}
          {!isNew && (
            <div className="flex items-center justify-end mt-4">
              <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={handleDelete}>Delete</Button>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
