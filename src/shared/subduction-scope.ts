/**
 * Keep a document between the peers that are in it.
 *
 * Subduction was built for a client talking to a sync server, so the Repo's
 * document source addresses "all connected peers": it asks every one of them to
 * sync each open document, subscribes to each document's presence topic with
 * every one of them, and publishes presence to whoever subscribed. Against one
 * trusted server that is fine. Here the connected peers are the user's friends'
 * devices, and a friend who is not in a document would be shown that it exists
 * — its id, its commit ids, when it changes — every time it synced. The
 * document policy would refuse them the content; it has no say over what this
 * device volunteers.
 *
 * So the three calls the Repo fans out with are replaced, on the Repo's own
 * subduction instance:
 *
 * - `syncWithAllPeers` syncs with each linked peer that keyhive says has access
 *   to the document, one `syncWithPeer` at a time, and reports the results in
 *   the shape the source reads (`entries()`). It never asks to *subscribe*: a
 *   subduction node that receives a subscription passes it on to every other
 *   peer it is connected to (`propagate_subscription` in subduction_core — how
 *   a chain of sync servers keeps a client fed), which here means a member's
 *   sync would make this device ask its other friends about the document.
 *   Nothing is lost by it: a change reaches a peer through the changer's own
 *   sync round, which the Repo runs after every save.
 * - `subscribeEphemeral` / `unsubscribeEphemeral` do nothing. Subduction's
 *   presence channel is not used: its subscriptions cannot be addressed to one
 *   peer, and the topic is the document id.
 * - `publishEphemeral` sends the message as a link datagram to each linked peer
 *   with access. The receiving side is `acceptEphemeral`, below.
 *
 * **Pacing.** A subduction sync round opens with a summary of the document
 * that grows with its whole history — measured at about 7 bytes per past
 * change, in each direction, however little has changed (compaction shrinks
 * what is stored, not this). The Repo starts a round after every save, so
 * typing in a long document would send that summary many times a second: two
 * people typing in a 4,000-change document measured 520 KB/s. So a document's
 * rounds are spaced by what the last one cost, holding its outbound traffic to
 * `PACE_BYTES_PER_SECOND`. A short document is not slowed at all; a long one
 * trades latency for bandwidth, and changes made while a round waits simply
 * ride the next one.
 *
 * **Recovery.** A round can fail for an ordinary reason: a document shared a
 * moment ago is refused by a peer whose keyhive has not heard of the share yet.
 * automerge-repo retries it ("heal"), and the retry succeeds — but a round that
 * succeeds on the heal path does not finish opening the document: it stays
 * "initializing", and while it is, commits arriving from peers are set aside
 * and never applied (seen in testing: an editor's changes reached the owner's
 * store and never her document). Only a round started by the document source
 * itself completes the transition. So when a document's round succeeds after
 * one that failed, `onRecovered` asks for one more, of the ordinary kind.
 *
 * These are the only peer-facing calls automerge-repo makes on the instance
 * (`grep "subduction\\." node_modules/@automerge/automerge-repo/src`); the rest
 * are local (`storeBuiltBatch`, `getBlobs`) or connection management this app
 * does itself.
 */
import { decode } from 'cbor-x';
import type { LinkedPeer, SubductionLinks } from './subduction-links';
import type { DocPolicy } from './subduction-policy';
import { createLogger } from './logger';

const log = createLogger('doc-sync');

/** A presence topic is the 32-byte document id. */
const TOPIC_BYTES = 32;

/** What one document's sync rounds may send, per second, to all its peers together. */
export const PACE_BYTES_PER_SECOND = 64 * 1024;
/** The longest a round is ever held back, however large the document. */
export const PACE_MAX_WAIT_MS = 5_000;

export interface ScopeDeps {
  links: Pick<SubductionLinks, 'linked' | 'sendDatagram' | 'bytesSent'>;
  policy: Pick<DocPolicy, 'allows'>;
  /**
   * A document's sync round succeeded after an earlier one failed. The caller
   * should start an ordinary round for it (`repo.resyncSubduction`) — see
   * "Recovery" above. Called outside the round, with the document's id bytes.
   */
  onRecovered?: (docIdBytes: Uint8Array) => void;
}

export interface SubductionScope {
  /** Release every round that is waiting its turn (the Repo is shutting down). */
  stop(): void;
}

export function scopeSubductionToMembers(subduction: any, deps: ScopeDeps): SubductionScope {
  // Per document: the earliest its next round may start.
  const nextRoundAt = new Map<string, number>();
  // Documents whose last round failed with some peer.
  const failing = new Set<string>();
  const waiting = new Set<() => void>();
  let stopped = false;
  const holdUntil = (at: number): Promise<void> => {
    const ms = at - Date.now();
    if (stopped || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const release = () => { clearTimeout(timer); waiting.delete(release); resolve(); };
      const timer = setTimeout(release, ms);
      (timer as any)?.unref?.();
      waiting.add(release);
    });
  };

  const members = async (docIdBytes: Uint8Array): Promise<LinkedPeer[]> => {
    const linked = deps.links.linked();
    const allowed = await Promise.all(linked.map((peer) => deps.policy.allows(peer.deviceKey, docIdBytes, 'relay')));
    return linked.filter((_, i) => allowed[i]);
  };

  subduction.syncWithAllPeers = async (sedimentreeId: any, _subscribe: boolean, timeoutMs?: number | null) => {
    const results: any[] = [];
    const doc = String(sedimentreeId);
    await holdUntil(nextRoundAt.get(doc) ?? 0);
    const startedAt = Date.now();
    const sentBefore = deps.links.bytesSent();
    const targets = await members(sedimentreeId.toBytes());
    if (log.enabled('debug')) {
      log.debug(`sync ${String(sedimentreeId).slice(0, 8)} with ${targets.length} of ${deps.links.linked().length} linked peers`);
    }
    await Promise.all(targets.map(async (peer) => {
      try {
        results.push(await subduction.syncWithPeer(peer.subductionPeerId, sedimentreeId, false, timeoutMs));
      } catch (err) {
        // The source reads `success` and `stats`; a throw from one peer must
        // not hide the others' results.
        log.debug('sync with a peer failed:', err);
        results.push({ success: false, stats: undefined, transportErrors: [err] });
      }
    }));
    // What this round sent (other documents' traffic in the same moment is
    // counted too; the error is on the side of sending less).
    const cost = deps.links.bytesSent() - sentBefore;
    nextRoundAt.set(doc, startedAt + Math.min(PACE_MAX_WAIT_MS, (cost / PACE_BYTES_PER_SECOND) * 1000));

    if (results.some((r) => !r.success)) {
      failing.add(doc);
    } else if (results.length > 0 && failing.delete(doc) && !stopped) {
      const docIdBytes: Uint8Array = sedimentreeId.toBytes();
      setTimeout(() => { if (!stopped) deps.onRecovered?.(docIdBytes); }, 0);
    }
    return { entries: () => results, getResult: () => undefined };
  };

  subduction.subscribeEphemeral = async () => {};
  subduction.unsubscribeEphemeral = async () => {};

  subduction.publishEphemeral = async (topic: any, payload: Uint8Array) => {
    const topicBytes: Uint8Array = topic.toBytes();
    const datagram = new Uint8Array(TOPIC_BYTES + payload.byteLength);
    datagram.set(topicBytes, 0);
    datagram.set(payload, TOPIC_BYTES);
    for (const peer of await members(topicBytes)) deps.links.sendDatagram(peer.peerId, datagram);
  };

  return {
    stop() {
      stopped = true;
      for (const release of [...waiting]) release();
    },
  };
}

export interface AcceptEphemeralDeps {
  policy: Pick<DocPolicy, 'allows'>;
  /** Whether the document is open on this device. */
  isOpen: (documentId: string) => boolean;
  /** The binary document id behind an automerge document id string. */
  docIdBytes: (documentId: string) => Uint8Array;
  /** Hand an ephemeral message to the Repo (`repo.synchronizer.receiveMessage`). */
  deliver: (message: unknown) => void;
}

/**
 * A presence datagram arrived from a linked peer. The Repo's own path for
 * subduction ephemerals trusts whatever sender and document the payload names,
 * and opens a query for any document id it is handed. This one takes the
 * message only when it says what the link already proved: it is from the peer
 * that signed the frame, about the document its topic names, which is open
 * here, and which that peer is a member of.
 */
export async function acceptEphemeral(peer: LinkedPeer, datagram: Uint8Array, deps: AcceptEphemeralDeps): Promise<void> {
  if (datagram.byteLength <= TOPIC_BYTES) return;
  const topic = datagram.subarray(0, TOPIC_BYTES);
  let message: any;
  try { message = decode(datagram.subarray(TOPIC_BYTES)); } catch { return; }
  if (message?.type !== 'ephemeral' || message.senderId !== peer.peerId || typeof message.documentId !== 'string') return;
  if (!deps.isOpen(message.documentId)) return;
  let docIdBytes: Uint8Array;
  try { docIdBytes = deps.docIdBytes(message.documentId); } catch { return; }
  if (docIdBytes.length !== TOPIC_BYTES || !docIdBytes.every((b, i) => b === topic[i])) return;
  if (!(await deps.policy.allows(peer.deviceKey, docIdBytes, 'relay'))) return;
  deps.deliver(message);
}
