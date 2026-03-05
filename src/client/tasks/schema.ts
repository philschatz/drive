import {
  type ValidationError, type SchemaNode,
  type LocalDateTime, type Duration, type PatchObject,
  type VirtualLocation, type Link,
  str, num, bool, obj, record, validateNode,
  LOCAL_DATE_TIME_RE, DURATION_RE,
  FREEBUSY_VALUES, PRIVACY_VALUES, PROGRESS_VALUES,
  boolMap, linkSchema, virtualLocationSchema, recurrenceRuleSchema,
} from '../../shared/schemas/core';
import type { RecurrenceRule } from '../calendar/schema';

export interface Task {
  "@type": "Task";
  title?: string;
  description?: string;
  location?: string;
  virtualLocations?: { [key: string]: VirtualLocation };
  links?: { [key: string]: Link };
  locale?: string;
  keywords?: { [key: string]: boolean };
  categories?: { [key: string]: boolean };
  color?: string;
  recurrenceRule?: RecurrenceRule;
  recurrenceOverrides?: { [key: string]: PatchObject };
  excluded?: boolean;
  start?: LocalDateTime;
  timeZone?: string | null;
  due?: LocalDateTime;
  estimatedDuration?: Duration;
  progress?: "needs-action" | "in-process" | "completed" | "failed" | "cancelled";
  percentComplete?: number;
  priority?: number;
  freeBusyStatus?: "free" | "busy" | "busy-tentative" | "busy-unavailable";
  privacy?: "public" | "private" | "confidential";
}

export interface TaskDocument {
  '@type': 'TaskList';
  name: string;
  description?: string;
  color?: string;
  timeZone?: string;
  tasks: Record<string, Task>;
}

export const taskSchema = obj({
  '@type': str({ enum: ['Task'] }),
  title: str({ optional: true }),
  description: str({ optional: true }),
  location: str({ optional: true }),
  virtualLocations: record(virtualLocationSchema, { optional: true }),
  links: record(linkSchema, { optional: true }),
  locale: str({ optional: true }),
  keywords: boolMap,
  categories: boolMap,
  color: str({ optional: true }),
  recurrenceRule: recurrenceRuleSchema,
  recurrenceOverrides: record(obj({}), { optional: true }),
  excluded: bool({ optional: true }),
  start: str({ pattern: LOCAL_DATE_TIME_RE, optional: true }),
  timeZone: str({ optional: true }),
  due: str({ pattern: LOCAL_DATE_TIME_RE, optional: true }),
  estimatedDuration: str({ pattern: DURATION_RE, optional: true }),
  progress: str({ enum: PROGRESS_VALUES, optional: true }),
  percentComplete: num({ min: 0, max: 100, integer: true, optional: true }),
  priority: num({ min: 0, max: 9, integer: true, optional: true }),
  freeBusyStatus: str({ enum: FREEBUSY_VALUES, optional: true }),
  privacy: str({ enum: PRIVACY_VALUES, optional: true }),
});

export const taskDocumentSchema = obj({
  '@type': str({ enum: ['TaskList'] }),
  name: str(),
  description: str({ optional: true }),
  color: str({ optional: true }),
  timeZone: str({ optional: true }),
  tasks: record(taskSchema),
});

export function checkTaskDependencies(doc: any, errors: ValidationError[]): void {
  const tasks = doc.tasks;
  if (!tasks || typeof tasks !== 'object') return;

  for (const [uid, task] of Object.entries(tasks)) {
    const t = task as any;
    const p = ['tasks', uid];

    if (t.start && t.due && t.start > t.due) {
      errors.push({ path: [...p, 'due'], message: `due "${t.due}" is before start "${t.start}"`, kind: 'dependency' });
    }

    if (t.recurrenceRule?.count != null && t.recurrenceRule?.until != null) {
      errors.push({ path: [...p, 'recurrenceRule'], message: 'count and until are mutually exclusive', kind: 'dependency' });
    }

    if (t.progress === 'completed' && t.percentComplete != null && t.percentComplete !== 100) {
      errors.push({
        path: [...p, 'percentComplete'],
        message: `percentComplete is ${t.percentComplete} but progress is "completed" (expected 100)`,
        kind: 'dependency',
      });
    }
    if (t.progress === 'needs-action' && t.percentComplete != null && t.percentComplete !== 0) {
      errors.push({
        path: [...p, 'percentComplete'],
        message: `percentComplete is ${t.percentComplete} but progress is "needs-action" (expected 0)`,
        kind: 'dependency',
      });
    }
  }
}

export function validateTask(task: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  validateNode(task, taskSchema, [], errors);
  return errors;
}
