/**
 * The core's khDelegates table collapses the per-message keyhive handlers into
 * one dispatch. Each delegate's return value becomes the `result` of the reply
 * envelope verbatim — except `kh-ensure-user-group`, which must wrap its raw
 * id in `{ userGroupId }` because the client unwraps it (worker-api caches the
 * id for the group's contact card).
 */
import { DriveEngine } from '../src/shared/drive-engine';

const ID = 'A'.repeat(43) + '=';

function makeEngine(khOps: any) {
  const emitted: any[] = [];
  const engine = new DriveEngine({
    emit: (e: any) => emitted.push(e),
    kv: {
      get: async () => null,
      set: async () => {},
      del: async () => {},
      delPrefix: async () => {},
    },
  } as any);
  (engine as any).khOps = khOps;
  return { engine, emitted };
}

describe('khDelegates result shapes', () => {
  it('kh-ensure-user-group wraps the raw id as { userGroupId }', async () => {
    const { engine, emitted } = makeEngine({
      ensureUserGroup: async () => ID,
    });
    await engine.handleMessage({ type: 'kh-ensure-user-group', id: 7, create: true });
    const reply = emitted.find((e: any) => e.type === 'result' && e.id === 7);
    expect(reply.error).toBeUndefined();
    expect(reply.result).toEqual({ userGroupId: ID });
  });

  it('kh-ensure-user-group propagates a null id for non-creating calls', async () => {
    const { engine, emitted } = makeEngine({
      ensureUserGroup: async () => null,
    });
    await engine.handleMessage({ type: 'kh-ensure-user-group', id: 8 });
    const reply = emitted.find((e: any) => e.type === 'result' && e.id === 8);
    expect(reply.error).toBeUndefined();
    expect(reply.result).toEqual({ userGroupId: null });
  });

  it('other delegates pass their raw return value through', async () => {
    const { engine, emitted } = makeEngine({
      getIdentity: async () => ({ agentId: ID }),
    });
    await engine.handleMessage({ type: 'kh-get-identity', id: 9 });
    const reply = emitted.find((e: any) => e.type === 'result' && e.id === 9);
    expect(reply.error).toBeUndefined();
    expect(reply.result).toEqual({ agentId: ID });
  });
});
