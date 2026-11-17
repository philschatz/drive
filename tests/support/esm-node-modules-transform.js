/**
 * Jest transform for ESM `.js` files (in practice: the @automerge packages in
 * node_modules that jest.config.js allows through transformIgnorePatterns).
 *
 * It is ts-jest's ESM→CJS transpile with one step in front: `import.meta.url`
 * is replaced by the file's own URL as a string literal. `import.meta` is a
 * syntax error in a CommonJS module, so a single use anywhere in a package's
 * import graph makes the whole package unloadable under Jest — automerge-repo
 * uses it to locate its worker entry files (`new URL('./worker.js',
 * import.meta.url)`), in code the tests never run. The replacement keeps those
 * expressions meaning what they meant.
 */
const { pathToFileURL } = require('node:url');
const tsJest = require('ts-jest').default;

const inner = tsJest.createTransformer({ useESM: false, diagnostics: false });

const rewrite = (src, filename) =>
  src.includes('import.meta.url')
    ? src.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(filename).href))
    : src;

module.exports = {
  process(src, filename, options) {
    return inner.process(rewrite(src, filename), filename, options);
  },
  getCacheKey(src, filename, options) {
    return inner.getCacheKey(rewrite(src, filename), filename, options);
  },
};
