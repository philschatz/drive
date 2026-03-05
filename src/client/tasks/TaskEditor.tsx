import { useState, useEffect, useRef, useMemo, useCallback } from 'preact/hooks';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import type { Task } from './schema';
import { PresenceDot } from '../../shared/presence';
import type { PeerFieldInfo } from '../../shared/presence';

interface TaskEditorProps {
  uid: string;
  task: Task;
  isNew: boolean;
  opened: boolean;
  onSave: (uid: string, data: Task) => void;
  onDelete: (uid: string) => void;
  onClose: () => void;
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

export function TaskEditor({ uid, task, isNew, opened, onSave, onDelete, onClose, onFieldFocus, peerFocusedFields }: TaskEditorProps) {
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
  useEffect(() => {
    const prev = prevTaskRef.current;
    prevTaskRef.current = task;
    if (prev.title !== task.title) setTitle(task.title || '');
    if (prev.due !== task.due) setDue(task.due ? task.due.substring(0, 10) : '');
    if (prev.priority !== task.priority) setPriority(task.priority || 0);
    if (prev.progress !== task.progress) setProgress(task.progress || 'needs-action');
    if (prev.description !== task.description) setDescription(task.description || '');
  }, [task]);

  const pd = (id: string) => <PresenceDot fieldId={id} peerFocusedFields={peerFocusedFields} />;
  const peerOpacity = (id: string) => peerFocusedFields?.[id] ? 0.5 : undefined;

  const handleSave = () => {
    const updated: any = {
      '@type': 'Task',
      title: title || 'Untitled',
      progress,
    };
    updated.due = due || undefined;
    updated.priority = priority || undefined;
    updated.description = description || undefined;
    onSave(uid, updated);
  };

  const handleDelete = () => {
    if (!confirm('Delete this task?')) return;
    onDelete(uid);
  };

  return (
    <Sheet open={opened} onOpenChange={(open: boolean) => { if (!open) onClose(); }}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>{isNew ? 'New Task' : 'Edit Task'}</SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-3 mt-4">
          <div style={{ opacity: peerOpacity('ted-title') }}>
            <Label className="flex items-center gap-1"><span>Title</span>{pd('ted-title')}</Label>
            <Input
              value={title}
              onInput={(e: any) => setTitle(e.currentTarget.value)}
              onFocus={() => focusField('ted-title')}
              onBlur={blurField}
              autoFocus
            />
          </div>

          <div style={{ opacity: peerOpacity('ted-due') }}>
            <Label className="flex items-center gap-1"><span>Due date</span>{pd('ted-due')}</Label>
            <Input
              type="date"
              value={due}
              onInput={(e: any) => setDue(e.currentTarget.value)}
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
              onBlur={blurField}
            />
          </div>

          <div style={{ opacity: peerOpacity('ted-progress') }}>
            <Label className="flex items-center gap-1"><span>Progress</span>{pd('ted-progress')}</Label>
            <Select value={progress} onValueChange={(v: string) => setProgress((v || 'needs-action') as any)}>
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
              onBlur={blurField}
              rows={3}
            />
          </div>

          <div className="flex items-center gap-2 mt-4">
            <Button onClick={handleSave}>Save</Button>
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            {!isNew && <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={handleDelete}>Delete</Button>}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
