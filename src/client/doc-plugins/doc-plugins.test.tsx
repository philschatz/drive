// The editor components drag in worker bootstrapping (import.meta) and
// schedule-x internals that don't load under jest; this test only checks
// registry metadata, so stub the Views out. The schema cores stay real.
jest.mock('../calendar/Calendar', () => ({ Calendar: () => null }));
jest.mock('../tasks/Tasks', () => ({ Tasks: () => null }));
jest.mock('../datagrid/DataGrid', () => ({ DataGrid: () => null }));
jest.mock('../counters/Counters', () => ({ Counters: () => null }));

import { DOC_PLUGINS } from './index';
import { SCHEMA_PLUGINS } from '../../shared/schemas';

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

  it('every validated type has a rendering plugin', () => {
    const renderTypes = new Set(DOC_PLUGINS.map(p => p.type));
    for (const p of SCHEMA_PLUGINS) {
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
