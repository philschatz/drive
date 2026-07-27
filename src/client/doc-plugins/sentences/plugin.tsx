import type { DocTypePlugin } from '../types';
import { sentencesSchemaPlugin } from '../../../shared/schemas/sentences';
import { lazyView } from '../../shared/lazy-view';

const SentencesView = lazyView(() => import('./SentencesView').then(m => m.SentencesView));

export const sentencesPlugin: DocTypePlugin = {
  ...sentencesSchemaPlugin,
  label: 'sentences',
  icon: 'description',
  createLabel: 'Sentences',
  createInitialDoc: name => ({ '@type': 'Sentences', name, content: '' }),
  View: SentencesView,
};
