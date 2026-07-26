import type { DocTypePlugin } from '../types';
import { taskListSchemaPlugin } from './schema';
import { lazyView } from '../../shared/lazy-view';

const Tasks = lazyView(() => import('./Tasks').then(m => m.Tasks));

export const taskListPlugin: DocTypePlugin = {
  ...taskListSchemaPlugin,
  label: 'task list',
  icon: 'checklist',
  createLabel: 'Task list',
  createInitialDoc: name => ({ '@type': 'TaskList', name, tasks: {} }),
  View: Tasks,
};
