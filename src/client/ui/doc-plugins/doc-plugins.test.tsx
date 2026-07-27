// The plugin Views are lazy (see common/lazy-view.ts), so importing the
// registry never loads the editor components — no View mocks needed here.
import { DOC_PLUGINS } from './index';
import { SCHEMA_PLUGINS } from '../../../shared/schemas';

/**
 * Types that are validated by the worker but intentionally have no editor View
 * (they are inspected/edited only through the universal source viewer), so they
 * are exempt from the "every validated type has a rendering plugin" rule.
 */
const HEADLESS_TYPES = new Set(['DriveSettings']);

/**
 * The registry is split across the worker boundary: rendering plugins live here
 * (Preact-bearing), their validation cores in src/shared/schemas (worker-safe).
 * These tests guard the two lists against drifting apart.
 */
describe('doc-plugins registry parity', () => {
  it('every rendering plugin has its schema core registered for worker-side validation', () => {
    const schemaTypes = new Set(SCHEMA_PLUGINS.map(p => p.type));
    for (const p of DOC_PLUGINS) {
      expect(schemaTypes).toContain(p.type);
    }
  });

  it('every validated type has a rendering plugin (except headless types)', () => {
    const renderTypes = new Set(DOC_PLUGINS.map(p => p.type));
    for (const p of SCHEMA_PLUGINS) {
      if (HEADLESS_TYPES.has(p.type)) continue;
      expect(renderTypes).toContain(p.type);
    }
  });

  it('plugins carry the exact schema objects the worker validates with', () => {
    for (const p of DOC_PLUGINS) {
      const core = SCHEMA_PLUGINS.find(s => s.type === p.type);
      expect(core).toBeDefined();
      expect(p.schema).toBe(core!.schema);
      expect(p.checkDeps).toBe(core!.checkDeps);
    }
  });
});
