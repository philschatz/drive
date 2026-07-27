import type { DocTypePlugin } from '../types';
import { countersSchemaPlugin } from '../../../../shared/schemas/counters';
import { lazyView } from '../../shared/lazy-view';

const Counters = lazyView(() => import('./Counters').then(m => m.Counters));

export const countersPlugin: DocTypePlugin = {
  ...countersSchemaPlugin,
  label: 'counter list',
  icon: 'event_repeat',
  createLabel: 'Habit Tracker',
  createInitialDoc: name => ({ '@type': 'Calendar+Counters', name, events: {} }),
  View: Counters,
};
