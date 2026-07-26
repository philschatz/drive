/**
 * The bundled example documents (repo-root `examples/*.json`), offered on the
 * home page when a user has no documents yet.
 *
 * `import.meta.glob` is lazy by default, so each example's JSON stays in its own
 * chunk and nothing is fetched until someone actually asks for the examples.
 */
const loaders = import.meta.glob<{ default: Record<string, unknown> }>('../../../examples/*.json');

export interface ExampleDoc {
  /** Bare file name, e.g. "calendar-family.json" — used as the fallback title. */
  fileName: string;
  /** Fetches and parses the example. */
  load: () => Promise<Record<string, unknown>>;
}

/** Every bundled example, in a stable (file-name) order. */
export function exampleDocs(): ExampleDoc[] {
  return Object.entries(loaders)
    .map(([filePath, load]) => ({
      fileName: filePath.slice(filePath.lastIndexOf('/') + 1),
      load: () => load().then(m => m.default),
    }))
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
}
