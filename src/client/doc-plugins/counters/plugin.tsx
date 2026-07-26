import type { DocTypePlugin } from '../types';
import { countersSchemaPlugin } from './schema';
import { Counters } from './Counters';

export const countersPlugin: DocTypePlugin = {
  ...countersSchemaPlugin,
  label: 'counter list',
  icon: 'event_repeat',
  createLabel: 'Habit Tracker',
  createInitialDoc: name => ({ '@type': 'Calendar+Counters', name, events: {} }),
  View: Counters,
};
