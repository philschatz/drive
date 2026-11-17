/**
 * The blob interceptor the Repo's subduction source runs every commit through:
 * the keyhive bridge's `KeyhiveBlobInterceptor`, behind a guard.
 *
 * The bridge's interceptor encrypts each commit under the document's keyhive
 * key on the way into subduction's store (so what is stored there, and what a
 * peer is sent from there, is ciphertext) and decrypts on the way out. But it
 * passes an *unprotected* document id straight through, in both directions —
 * that is how upstream keeps pre-keyhive documents working. Here it would be a
 * hole: any document minted outside the keyhive create path (`repo.create`,
 * `clone`, `import` without an id) would be stored and sent as plaintext.
 *
 * So the guard refuses those ids. Returning `null` tells the source to skip the
 * blob: an unprotected document is never written to subduction's store, so
 * there is nothing of it to send, and nothing of it is accepted from a peer.
 */
import { createLogger } from './logger';

const log = createLogger('doc-sync');

/** automerge-repo's `BlobInterceptor` (subduction/source.ts). */
export interface BlobInterceptor {
  transformOutgoing(
    documentId: string, commitId: string, parents: string[], blob: Uint8Array,
    loadBlob: (commitIdHex: string) => Promise<Uint8Array | null>,
  ): Promise<Uint8Array | null>;
  transformIncoming(
    documentId: string, commitId: string, blob: Uint8Array,
    loadBlob: (commitIdHex: string) => Promise<Uint8Array | null>,
  ): Promise<Uint8Array | null>;
}

/**
 * Whether a document id is one keyhive does not protect: shorter than 32
 * bytes, or 16 real bytes zero-padded to 32. A keyhive document id uses all 32
 * bytes. The same rule as the bridge's `isUnprotectedDocId`, which it does not
 * export; subduction-interceptor.test.ts holds the two to each other.
 */
export function isUnprotectedDocId(bytes: Uint8Array): boolean {
  if (bytes.length < 32) return true;
  for (let i = 16; i < 32; i++) if (bytes[i] !== 0) return false;
  return true;
}

export interface GuardedInterceptor extends BlobInterceptor {
  /** Whether any blob has arrived that could not be decrypted yet and has not been since. */
  hasPendingDecrypts(): boolean;
}

/**
 * How long an undecryptable blob counts as "pending". One that still cannot be
 * read after this long is not waiting for a key in transit — this device was
 * never given it, or no longer has access — and must not keep retries alive.
 */
export const PENDING_DECRYPT_TTL_MS = 10 * 60_000;

export interface GuardedInterceptorOptions {
  /** The bridge's interceptor. A promise because it needs the hive, which is built after the Repo's config is. */
  inner: Promise<BlobInterceptor>;
  /** The binary document id behind an automerge document id string. */
  docIdBytes: (documentId: string) => Uint8Array;
  /** A blob arrived that cannot be decrypted yet: its key has not reached this device. */
  onPendingDecrypt?: () => void;
  /** Clock, for tests. */
  now?: () => number;
}

export function makeGuardedInterceptor(opts: GuardedInterceptorOptions): GuardedInterceptor {
  // Refused ids, so each is logged once rather than on every retried save.
  const refused = new Set<string>();
  // Documents whose changes could not be encrypted, so that is one line each.
  const unencryptable = new Set<string>();
  // `<documentId>/<commitId>` of blobs that arrived undecryptable → when first seen.
  const pending = new Map<string, number>();
  const now = opts.now ?? Date.now;

  const unprotected = (documentId: string): boolean => {
    let isUnprotected = true;
    try { isUnprotected = isUnprotectedDocId(opts.docIdBytes(documentId)); } catch { /* unreadable id: refuse */ }
    if (isUnprotected && !refused.has(documentId)) {
      refused.add(documentId);
      log.warn(`document ${documentId} is not keyhive-protected: it is kept off document sync, and stays on this device`);
    }
    return isUnprotected;
  };

  return {
    async transformOutgoing(documentId, commitId, parents, blob, loadBlob) {
      if (unprotected(documentId)) return null;
      try {
        return await (await opts.inner).transformOutgoing(documentId, commitId, parents, blob, loadBlob);
      } catch (err) {
        // The bridge throws when it has a key state but cannot encrypt under it
        // — a device removed from the document still editing its copy, for one.
        // Either way the change must not be stored for sync unencrypted, and
        // `null` is how the Repo is told to skip it and try again on a later save.
        if (!unencryptable.has(documentId)) {
          unencryptable.add(documentId);
          log.warn(`cannot encrypt changes to ${documentId} (no access?): they stay on this device.`, err);
        }
        return null;
      }
    },
    async transformIncoming(documentId, commitId, blob, loadBlob) {
      if (unprotected(documentId)) return null;
      const key = `${documentId}/${commitId}`;
      let plain: Uint8Array | null;
      try {
        plain = await (await opts.inner).transformIncoming(documentId, commitId, blob, loadBlob);
      } catch (err) {
        // The Repo treats a throw here as final: it has already recorded the
        // commit as known, logs the error at debug and never offers the blob
        // again. A blob that cannot be read now is one to retry, whatever the
        // reason, so report it the way the Repo retries: as not transformable yet.
        log.warn(`decrypting a commit of ${documentId} failed, will retry:`, err);
        plain = null;
      }
      if (log.enabled('debug')) {
        log.debug(`incoming ${documentId.slice(0, 8)}/${commitId.slice(0, 8)}: ${plain ? 'decrypted' : 'not readable yet'}`);
      }
      if (plain !== null) {
        pending.delete(key);
      } else if (!pending.has(key)) {
        pending.set(key, now());
        opts.onPendingDecrypt?.();
      }
      return plain;
    },
    hasPendingDecrypts: () => {
      const cutoff = now() - PENDING_DECRYPT_TTL_MS;
      for (const [key, since] of pending) if (since < cutoff) pending.delete(key);
      return pending.size > 0;
    },
  };
}
