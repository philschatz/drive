/**
 * The bundled example documents, offered on the home page when a user has no
 * documents yet. The `*.json` / `*.md` sources sit alongside this file.
 *
 * Two kinds: `*.json` whole documents, and `*.md` which become Sentences
 * documents — Sentences structure lives in Automerge marks and block markers,
 * which the JSON projection can't represent, so Markdown is the authoring format.
 *
 * `import.meta.glob` is lazy by default, so each example stays in its own chunk
 * and nothing is fetched until someone actually asks for the examples.
 */
import type { ImportItem } from '../import-docs';

const jsonLoaders = import.meta.glob<{ default: Record<string, unknown> }>('./*.json');
const markdownLoaders = import.meta.glob<string>('./*.md', { query: '?raw', import: 'default' });

const baseName = (filePath: string) => filePath.slice(filePath.lastIndexOf('/') + 1);

/** Every bundled example, in a stable (file-name) order. */
export function exampleDocs(): ImportItem[] {
  const json: ImportItem[] = Object.entries(jsonLoaders).map(([filePath, load]) => ({
    kind: 'json',
    label: baseName(filePath),
    read: () => load().then(m => m.default),
  }));
  const markdown: ImportItem[] = Object.entries(markdownLoaders).map(([filePath, load]) => ({
    kind: 'markdown',
    label: baseName(filePath),
    read: () => load(),
  }));
  return [...json, ...markdown].sort((a, b) => a.label.localeCompare(b.label));
}
