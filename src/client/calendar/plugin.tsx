import type { DocTypePlugin } from '../doc-plugins/types';
import { calendarSchemaPlugin } from './schema';
import { Calendar } from './Calendar';

export const calendarPlugin: DocTypePlugin = {
  ...calendarSchemaPlugin,
  label: 'calendar',
  icon: 'date_range',
  createLabel: 'Calendar',
  createInitialDoc: name => ({ '@type': 'Calendar', name, events: {} }),
  View: Calendar,
};
