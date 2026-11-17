/**
 * Who may be served, and who may write, over document sync.
 *
 * Subduction asks its `Policy` before it answers a peer: may this peer connect,
 * may it fetch this document, may it put a commit by this author. A peer is
 * identified by the Ed25519 key it proved in the handshake — which, because the
 * Repo signs as the device's keyhive key (subduction-signer.ts), is the key
 * keyhive's membership graph is about. So every answer is a keyhive question.
 *
 * This replaces the bridge's `buildServerSubductionPolicy`, which differs in
 * three ways that matter here: it calls keyhive off the shared queue (keyhive
 * WASM is not reentrant), it lets unprotected document ids through, and it
 * accepts a commit only if its *author* can edit — judged by the author's
 * access now, so a new device would refuse the earlier work of a device that
 * has since been removed.
 */
import { isUnprotectedDocId } from './subduction-interceptor';
import { createLogger } from './logger';

const log = createLogger('doc-sync');

/** The access a rule asks for. Keyhive orders them relay < read < edit < admin. */
export type RequiredAccess = 'relay' | 'edit';

export interface DocPolicyDeps {
  /**
   * Whether the device with this key holds at least `level` on the document
   * with these id bytes, as far as this device's keyhive knows. Must run its
   * keyhive call on the shared keyhive queue.
   */
  hasAccess(deviceKey: Uint8Array, docIdBytes: Uint8Array, level: RequiredAccess): Promise<boolean>;
  /** Whether a link with this device is wanted at all. */
  mayConnect(deviceKey: Uint8Array): Promise<boolean>;
}

/** Subduction's `Policy` interface, over the two WASM id types it passes (both have `toBytes()`). */
export interface DocPolicy {
  authorizeConnect(peerId: { toBytes(): Uint8Array }): Promise<void>;
  authorizeFetch(peerId: { toBytes(): Uint8Array }, sedimentreeId: { toBytes(): Uint8Array }): Promise<void>;
  authorizePut(
    requestor: { toBytes(): Uint8Array }, author: { toBytes(): Uint8Array }, sedimentreeId: { toBytes(): Uint8Array },
  ): Promise<void>;
  filterAuthorizedFetch<T extends { toBytes(): Uint8Array }>(peerId: { toBytes(): Uint8Array }, ids: T[]): Promise<T[]>;
  /**
   * The answer the rules above are built from, for callers deciding what to
   * *offer* a peer rather than what to grant it: whether the device holds at
   * least `level` on a protected document. Cached like the rest.
   */
  allows(deviceKey: Uint8Array, docIdBytes: Uint8Array, level: RequiredAccess): Promise<boolean>;
  /** Forget cached answers. Call whenever keyhive's state changes. */
  invalidate(): void;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function makeDocPolicy(deps: DocPolicyDeps): DocPolicy {
  // One sync round asks the same question many times over (once per commit for
  // a put), and each ask is a hop through the keyhive queue.
  let cache = new Map<string, Promise<boolean>>();

  const allowed = (deviceKey: Uint8Array, docIdBytes: Uint8Array, level: RequiredAccess): Promise<boolean> => {
    if (isUnprotectedDocId(docIdBytes)) return Promise.resolve(false);
    const key = `${hex(deviceKey)}|${hex(docIdBytes)}|${level}`;
    let answer = cache.get(key);
    if (!answer) {
      answer = deps.hasAccess(deviceKey, docIdBytes, level).catch((err) => {
        log.warn('access check failed, denying:', err);
        return false;
      });
      cache.set(key, answer);
    }
    return answer;
  };

  return {
    async authorizeConnect(peerId) {
      if (!(await deps.mayConnect(peerId.toBytes()))) throw new Error('no link wanted with this device');
    },

    async authorizeFetch(peerId, sedimentreeId) {
      if (!(await allowed(peerId.toBytes(), sedimentreeId.toBytes(), 'relay'))) {
        throw new Error('no access to this document');
      }
    },

    // The author, or the peer handing the commit over. A current editor could
    // write the same content itself, so taking a commit from one is no weaker
    // than trusting that editor — and it is what lets the earlier work of a
    // device that has since been removed reach a device linked afterwards.
    async authorizePut(requestor, author, sedimentreeId) {
      const sid = sedimentreeId.toBytes();
      if (await allowed(author.toBytes(), sid, 'edit')) return;
      if (await allowed(requestor.toBytes(), sid, 'edit')) return;
      throw new Error('neither the author nor the sender may edit this document');
    },

    async filterAuthorizedFetch(peerId, ids) {
      const key = peerId.toBytes();
      const kept: typeof ids = [];
      for (const id of ids) if (await allowed(key, id.toBytes(), 'relay')) kept.push(id);
      return kept;
    },

    allows: allowed,

    invalidate() { cache = new Map(); },
  };
}
