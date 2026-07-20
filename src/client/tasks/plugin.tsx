import type { DocTypePlugin } from '../doc-plugins/types';
import { taskListSchemaPlugin } from './schema';
import { Tasks } from './Tasks';

export const taskListPlugin: DocTypePlugin = {
  ...taskListSchemaPlugin,
  label: 'task list',
  icon: 'checklist',
  createLabel: 'Task list',
  createInitialDoc: name => ({ '@type': 'TaskList', name, tasks: {} }),
  View: Tasks,
};
