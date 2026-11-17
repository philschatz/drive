import type { DocTypePlugin } from '../types';
import { timelineSchemaPlugin, createTimelineDoc } from '../../../../shared/schemas/timeline';
import { lazyView } from '../../common/lazy-view';

const Timeline = lazyView(() => import('./Timeline').then(m => m.Timeline));

export const timelinePlugin: DocTypePlugin = {
  ...timelineSchemaPlugin,
  label: 'timeline',
  icon: 'timeline',
  createLabel: 'Timeline',
  createInitialDoc: name => ({ ...createTimelineDoc(name) }),
  View: Timeline,
};
