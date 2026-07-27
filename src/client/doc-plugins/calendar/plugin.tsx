import type { DocTypePlugin } from '../types';
import { calendarSchemaPlugin } from '../../../shared/schemas/calendar';
import { lazyView } from '../../shared/lazy-view';

const Calendar = lazyView(() => import('./Calendar').then(m => m.Calendar));

export const calendarPlugin: DocTypePlugin = {
  ...calendarSchemaPlugin,
  label: 'calendar',
  icon: 'date_range',
  createLabel: 'Calendar',
  createInitialDoc: name => ({ '@type': 'Calendar', name, events: {} }),
  View: Calendar,
};
