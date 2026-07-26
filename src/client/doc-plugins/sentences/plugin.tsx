import type { DocTypePlugin } from '../types';
import { sentencesSchemaPlugin } from './schema';
import { SentencesView } from './SentencesView';

export const sentencesPlugin: DocTypePlugin = {
  ...sentencesSchemaPlugin,
  label: 'sentences',
  icon: 'description',
  createLabel: 'Sentences',
  createInitialDoc: name => ({ '@type': 'Sentences', name, content: '' }),
  View: SentencesView,
};
