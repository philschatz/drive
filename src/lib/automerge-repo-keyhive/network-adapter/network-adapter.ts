import {
  Message,
  NetworkAdapter,
  PeerId,
  PeerMetadata,
} from "@automerge/automerge-repo/slim";
import {
  ChangeId,
  ContactCard,
  Document as KeyhiveDocument,
  DocumentId as KeyhiveDocumentId,
  Encrypted,
  Identifier,
  Keyhive,
} from "@keyhive/keyhive/slim";
import { encode, decode } from "cbor-x";
import { cborByteString, buildSyncResponseCbor, buildCborByteStringArray, buildSyncOpsCbor } from "./cbor-builder";

interface EventBytesResult {
  events: Uint8Array[];
  cborEvents: Uint8Array[];
}

import {
  decodeKeyhiveMessageData,
  ENC_ENCRYPTED,
  KeyhiveMessageData,
  signData,
  verifyData,
} from "./messages";
import { PromiseQueue, Pending } from "./pending";
import { OpCache } from "./op-cache";
import { getEventsForAgent, getEventHashesForAgent, keyhiveIdentifierFromPeerId, isKeyhivePeerId } from "../utilities";
import {
  getPendingOpHashes,
  KeyhiveStorage,
  receiveContactCard,
} from "../keyhive/keyhive";

/** Set to true to enable verbose debug logging in the keyhive network adapter. */
let KH_DEBUG = false;
function debug(...args: any[]) { if (KH_DEBUG) console.log('[AMRepoKeyhive]', ...args); }

// Map from hash string to hash bytes
type PeerHashes = Map<string, Uint8Array>;

type KeyhiveMessage = {
  msg: Message;
  data: KeyhiveMessageData;
}

class Metrics {
  private msgTypeCounts: Record<string, number> = {};
  private totalPayloadBytes = 0;
  private uniqueSenders = new Set<string>();
  private nonKeyhiveCount = 0;
  private droppedSyncRequests = 0;
  private messageCount = 0;
  private totalProcessingTimeMs = 0;
  private publicHashCount = 0;
  private publicEventCount = 0;

  // #1 Per-type processing time
  private processingTimeByType: Record<string, number> = {};
  // #2 Event count
  private totalOps: bigint = 0n;
  // #3 Hash/event lookup timing
  private hashLookupTimeMs = 0;
  private eventLookupTimeMs = 0;
  // #4 Cache hit/miss
  private cacheHits = 0;
  private cacheMisses = 0;
  // #5 Queue wait time
  private totalQueueWaitMs = 0;
  // #6 Ingestion metrics
  private ingestCount = 0;
  private eventsIngested = 0;
  private pendingAfterIngest = 0;
  private storageRetries = 0;
  // #7 Ops sent/requested
  private opsSent = 0;
  private opsRequested = 0;
  // #8 Sync check metrics
  private syncChecksSent = 0;
  private syncChecksReceived = 0;
  private syncChecksShortCircuited = 0;
  private syncChecksFallback = 0;
  private syncConfirmationsSent = 0;
  private syncConfirmationsReceived = 0;

  recordMessage(msgType: string | undefined, senderId: string | undefined, payloadBytes: number) {
    const type = msgType ?? "unknown";
    this.msgTypeCounts[type] = (this.msgTypeCounts[type] ?? 0) + 1;
    this.totalPayloadBytes += payloadBytes;
    if (senderId) this.uniqueSenders.add(senderId);
    this.messageCount++;
  }

  recordNonKeyhive() {
    this.nonKeyhiveCount++;
  }

  recordDroppedSyncRequest() {
    this.droppedSyncRequests++;
  }

  recordProcessingTime(ms: number) {
    this.totalProcessingTimeMs += ms;
  }

  recordPublicLookups(hashCount: number, eventCount: number) {
    this.publicHashCount += hashCount;
    this.publicEventCount += eventCount;
  }

  recordProcessingTimeByType(msgType: string, ms: number) {
    this.processingTimeByType[msgType] = (this.processingTimeByType[msgType] ?? 0) + ms;
  }

  recordTotalOps(ops: bigint) {
    this.totalOps = ops;
  }

  recordHashLookupTime(ms: number) {
    this.hashLookupTimeMs += ms;
  }

  recordEventLookupTime(ms: number) {
    this.eventLookupTimeMs += ms;
  }

  recordCacheHit() {
    this.cacheHits++;
  }

  recordCacheMiss() {
    this.cacheMisses++;
  }

  recordQueueWait(ms: number) {
    this.totalQueueWaitMs += ms;
  }

  recordIngestion(eventsCount: number, pendingCount: number) {
    this.ingestCount++;
    this.eventsIngested += eventsCount;
    this.pendingAfterIngest += pendingCount;
  }

  recordStorageRetry() {
    this.storageRetries++;
  }

  recordOpsSent(count: number) {
    this.opsSent += count;
  }

  recordOpsRequested(count: number) {
    this.opsRequested += count;
  }

  recordSyncCheckSent() { this.syncChecksSent++; }
  recordSyncCheckReceived() { this.syncChecksReceived++; }
  recordSyncCheckShortCircuited() { this.syncChecksShortCircuited++; }
  recordSyncCheckFallback() { this.syncChecksFallback++; }
  recordSyncConfirmationSent() { this.syncConfirmationsSent++; }
  recordSyncConfirmationReceived() { this.syncConfirmationsReceived++; }

  hasActivity(): boolean {
    return this.messageCount > 0 || this.nonKeyhiveCount > 0;
  }

  logReport(label: string) {
    if (!this.hasActivity()) return;
    const countsStr = Object.entries(this.msgTypeCounts)
      .map(([type, count]) => `${type}=${count}`)
      .join(", ");
    debug(
      `[${label}] ${this.messageCount} keyhive messages from ${this.uniqueSenders.size} peers at ${new Date().toLocaleTimeString("en-GB")}. ` +
      `${this.droppedSyncRequests} duplicate sync requests dropped. ` +
      `${this.nonKeyhiveCount} non-keyhive messages. ` +
      `Breakdown: ${countsStr}. Total payload: ${this.totalPayloadBytes} bytes. ` +
      `Processing: ${this.totalProcessingTimeMs}ms. ` +
      `Public lookups: ${this.publicHashCount} hashes, ${this.publicEventCount} events`
    );
    const perTypeStr = Object.entries(this.processingTimeByType)
      .map(([type, ms]) => `${type}=${ms}ms`)
      .join(", ");
    debug(
      `[${label}+] Per-type: ${perTypeStr}. ` +
      `Lookups: hash=${this.hashLookupTimeMs}ms, event=${this.eventLookupTimeMs}ms. ` +
      `Cache: ${this.cacheHits}/${this.cacheMisses} hit/miss. ` +
      `Queue wait: ${this.totalQueueWaitMs}ms. ` +
      `Ingestion: ${this.ingestCount}x, ${this.eventsIngested} events, ${this.pendingAfterIngest} pending, ${this.storageRetries} retries. ` +
      `Ops: ${this.opsSent} sent, ${this.opsRequested} requested. ` +
      `Sync checks: ${this.syncChecksSent} sent, ${this.syncChecksReceived} rcvd, ${this.syncChecksShortCircuited} short-circuited, ${this.syncChecksFallback} fallback. ` +
      `Confirmations: ${this.syncConfirmationsSent} sent, ${this.syncConfirmationsReceived} rcvd. ` +
      `Total ops: ${this.totalOps}`
    );
  }

  reset() {
    this.msgTypeCounts = {};
    this.totalPayloadBytes = 0;
    this.uniqueSenders = new Set();
    this.nonKeyhiveCount = 0;
    this.droppedSyncRequests = 0;
    this.messageCount = 0;
    this.totalProcessingTimeMs = 0;
    this.publicHashCount = 0;
    this.publicEventCount = 0;
    this.processingTimeByType = {};
    this.totalOps = 0n;
    this.hashLookupTimeMs = 0;
    this.eventLookupTimeMs = 0;
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.totalQueueWaitMs = 0;
    this.ingestCount = 0;
    this.eventsIngested = 0;
    this.pendingAfterIngest = 0;
    this.storageRetries = 0;
    this.opsSent = 0;
    this.opsRequested = 0;
    this.syncChecksSent = 0;
    this.syncChecksReceived = 0;
    this.syncChecksShortCircuited = 0;
    this.syncChecksFallback = 0;
    this.syncConfirmationsSent = 0;
    this.syncConfirmationsReceived = 0;
  }
}

class MessageBatch {
  readonly messages: KeyhiveMessage[] = [];
  readonly metrics = new Metrics();
  private readonly syncRequestSenders = new Set<string>();

  add(msg: Message, data: KeyhiveMessageData) {
    if (msg.type === "keyhive-sync-request" && msg.senderId) {
      if (this.syncRequestSenders.has(msg.senderId)) {
        this.metrics.recordDroppedSyncRequest();
        return;
      }
      this.syncRequestSenders.add(msg.senderId);
    }
    this.metrics.recordMessage(msg.type, msg.senderId, data.signed.payload?.byteLength ?? 0);
    this.messages.push({ msg, data });
  }

  countNonKeyhive() {
    this.metrics.recordNonKeyhive();
  }

  get isEmpty(): boolean {
    return !this.metrics.hasActivity();
  }
}

class BatchProcessor {
  private timeoutId?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly batchInterval: number,
    private readonly keyhive: Keyhive,
    private readonly handleMessage: (msg: Message, data: KeyhiveMessageData, metrics: Metrics) => Promise<void>,
    private readonly swapBatch: () => MessageBatch,
  ) {}

  start() {
    this.scheduleNext();
  }

  stop() {
    if (this.timeoutId !== undefined) {
      clearTimeout(this.timeoutId);
      this.timeoutId = undefined;
    }
  }

  private scheduleNext() {
    this.timeoutId = setTimeout(() => { void this.processAndReschedule() }, this.batchInterval);
  }

  private async processAndReschedule() {
    const batch = this.swapBatch();
    if (!batch.isEmpty) {
      await this.processBatch(batch);
    }
    this.scheduleNext();
  }

  private async processBatch(batch: MessageBatch) {
    const startTime = Date.now();
    for (const { msg, data } of batch.messages) {
      try {
        const msgStart = Date.now();
        await this.handleMessage(msg, data, batch.metrics);
        batch.metrics.recordProcessingTimeByType(msg.type ?? "unknown", Date.now() - msgStart);
      } catch (error) {
        console.error(`[AMRepoKeyhive] Error processing batch message (type=${msg.type}, from=${msg.senderId}):`, error);
      }
    }
    batch.metrics.recordProcessingTime(Date.now() - startTime);
    const stats = await this.keyhive.stats();
    batch.metrics.recordTotalOps(stats.totalOps);
    batch.metrics.logReport("Batch");
  }
}

class Peer {
  lastKeyhiveRequestRcvd: Date = new Date();
  lastKeyhiveRequestSent: Date = new Date();
  // Null until first full sync completes with this peer
  beliefCounts: {
    myTotalForThem: number;    // my hash count for them (recomputable but cached)
    theirTotalForMe: number;   // my belief about their hash count for me (learned from them)
  } | null = null;
  // When true, forces a full sync request instead of a lightweight check.
  // Set when new CGKA ops are generated locally (e.g., during encryption).
  // Cleared after the full sync request is sent.
  forceFullSync: boolean = false;
  // Whether keyhive sync has completed with this peer. When false, outgoing
  // sync messages are sent unencrypted to avoid the deadlock where A encrypts
  // with a PCS key B doesn't have (B not yet in A's CGKA tree).
  // Set to true after keyhive-sync-confirmation is sent or received.
  // Reset to false by forceResyncAllPeers() when CGKA state changes.
  keyhiveSynced: boolean = false;
  constructor() {}
};

export class KeyhiveNetworkAdapter extends NetworkAdapter {
  private pending = new Pending();
  // Connected peers and metadata
  private peers: Map<PeerId, Peer> = new Map();
  private syncIntervalId?: ReturnType<typeof setInterval> | undefined;
  private compactionIntervalId?: ReturnType<typeof setInterval>;
  private batchProcessor?: BatchProcessor;

  private cacheHashes: boolean;
  // Old per-message cache fields (only used when cacheHashes=false)
  private hashesCache: Map<PeerId, PeerHashes> = new Map();
  private publicHashesCache: PeerHashes | null = null;
  private publicEventsCache: Map<Uint8Array, any> | null = null;
  private pendingOpHashesCache: Uint8Array[] | null = null;
  private lastKnownTotalOps: bigint = 0n;

  // CGKA encryption: maps automerge DocumentId strings to keyhive DocumentIds
  private docMap: Map<string, KeyhiveDocumentId> = new Map();
  // Cache of fetched keyhive Document objects, keyed by automerge DocumentId
  private docObjects: Map<string, KeyhiveDocument> = new Map();
  // Tracks the last ChangeId used per document for pred_refs chaining
  private lastChangeIdByDoc: Map<string, ChangeId> = new Map();
  // Messages that failed decryption (key not yet available) — retried after keyhive sync
  private pendingDecrypt: { message: Message; rawPayload: Uint8Array; automergeDocId: string; retries: number }[] = [];

  // Periodic op cache (only used when cacheHashes=true)
  private opCache: OpCache | null = null;
  private opCacheRefreshId?: ReturnType<typeof setInterval>;

  private minSyncRequestInterval: number = 1000;
  private minSyncResponseInterval: number = 1000;

  private batchInterval: number | undefined;
  private keyhiveMsgBatch: MessageBatch;
  private streamingMetrics = new Metrics();
  private metricsIntervalId?: ReturnType<typeof setInterval>;
  // Persistent maps for immutable event data (only used when cacheHashes=false)
  private eventBytes: Map<string, Uint8Array> = new Map();
  private eventCborBytes: Map<string, Uint8Array> = new Map();

  constructor(
    private networkAdapter: NetworkAdapter,
    private contactCard: ContactCard,
    private keyhive: Keyhive,
    private keyhiveStorage: KeyhiveStorage,
    private keyhiveQueue: PromiseQueue,
    periodicallyRequestSync: boolean,
    cacheHashes: boolean = false,
    // TODO: Replace with dynamic configuration
    private hardcodedRemoteId: PeerId | null = null,
    private syncRequestInterval: number,
    batchInterval?: number,
    private retryPendingFromStorage: boolean = true,
    enableCompaction: boolean = true,
  ) {
    super();
    this.cacheHashes = cacheHashes;

    if (cacheHashes) {
      this.opCache = new OpCache();
      // Periodic refresh at the same interval as sync requests
      this.opCacheRefreshId = setInterval(() => {
        void this.keyhiveQueue.run(() => this.opCache!.refresh(this.keyhive));
      }, syncRequestInterval);
      // Initial refresh
      void this.keyhiveQueue.run(() => this.opCache!.refresh(this.keyhive));
    }

    if (periodicallyRequestSync) {
        this.syncIntervalId = setInterval(this.requestKeyhiveSync.bind(this), syncRequestInterval);
    }

    if (enableCompaction) {
      this.compactionIntervalId = setInterval(
        this.runCompaction.bind(this),
        60000
      );
    }

    networkAdapter.on("message", (msg) => {
      this.receiveMessage(msg);
    });

    networkAdapter.on("peer-candidate", (payload) => {
      if (this.peerId && payload.peerId == this.peerId) {
        debug(`Received peer-candidate msg with our own peerID`);
        return;
      }
      debug(`[AMRepoKeyhive] peer-candidate: ${payload.peerId}`);
      this.emit("peer-candidate", payload);
      this.peers.set(payload.peerId, new Peer());
    });

    networkAdapter.on("peer-disconnected", (payload) => {
      this.emit("peer-disconnected", payload);
      this.peers.delete(payload.peerId);
      if (!this.opCache) {
        this.hashesCache.delete(payload.peerId);
      }
    });

    this.keyhiveMsgBatch = new MessageBatch();

    this.batchInterval = batchInterval;
    if (this.isBatching()) {
      this.batchProcessor = new BatchProcessor(
        this.batchInterval!,
        this.keyhive,
        this.handleKeyhiveMessage.bind(this),
        () => {
          const old = this.keyhiveMsgBatch;
          this.keyhiveMsgBatch = new MessageBatch();
          return old;
        },
      );
      this.batchProcessor.start();
    } else {
      this.metricsIntervalId = setInterval(async () => {
        const stats = await this.keyhive.stats();
        this.streamingMetrics.recordTotalOps(stats.totalOps);
        this.streamingMetrics.logReport("Streaming");
        this.streamingMetrics.reset();
      }, 1000);
    }
  }

  connect(peerId: PeerId, peerMetadata?: PeerMetadata): void {
    debug(`this.peerId: ${peerId}`);
    this.peerId = peerId;
    this.peerMetadata = peerMetadata;
    this.networkAdapter.connect(peerId, peerMetadata);
  }

  isReady(): boolean {
    return this.networkAdapter.isReady();
  }

  whenReady(): Promise<void> {
    return this.networkAdapter.whenReady();
  }

  isBatching(): boolean {
    return this.batchInterval !== undefined
  }

  disconnect(): void {
    if (this.syncIntervalId) {
      clearInterval(this.syncIntervalId);
      this.syncIntervalId = undefined;
    }
    if (this.compactionIntervalId) {
      clearInterval(this.compactionIntervalId);
      this.compactionIntervalId = undefined;
    }
    if (this.batchProcessor) {
      this.batchProcessor.stop();
      this.batchProcessor = undefined;
    }
    if (this.metricsIntervalId) {
      clearInterval(this.metricsIntervalId);
      this.metricsIntervalId = undefined;
    }
    if (this.opCacheRefreshId) {
      clearInterval(this.opCacheRefreshId);
      this.opCacheRefreshId = undefined;
    }
    this.networkAdapter.disconnect();
  }

  /**
   * Force automerge-repo to re-sync with all connected peers by cycling
   * peer-disconnected → peer-candidate events. This resets automerge-repo's
   * sync state for each peer, forcing fresh sync from scratch.
   *
   * A simple peer-candidate re-emit is insufficient because automerge-repo
   * ignores peer-candidate for already-connected peers.
   *
   * Call after keyhive state changes (e.g., new member ingested, invite claim).
   */
  forceResyncAllPeers(): void {
    this.docObjects.clear();
    debug(`forceResyncAllPeers: cycling disconnect/reconnect for ${this.peers.size} peers`);
    for (const [peerId, peer] of this.peers) {
      // Reset keyhiveSynced so outgoing sync messages are unencrypted until
      // the next keyhive sync confirmation. This prevents the deadlock where
      // A encrypts with a PCS key B doesn't have yet.
      peer.keyhiveSynced = false;
      // Emit disconnect to tear down automerge-repo's sync state for this peer.
      // We do NOT delete from this.peers — we keep our keyhive-level peer tracking.
      this.emit("peer-disconnected", { peerId });
      this.emit("peer-candidate", { peerId, peerMetadata: {} });
    }
  }

  // Register a mapping from automerge DocumentId to keyhive DocumentId.
  // Call this after enabling sharing on a document.
  registerDoc(automergeDocId: string, khDocId: KeyhiveDocumentId): void {
    debug(`registerDoc: ${automergeDocId} → keyhive doc`);
    this.docMap.set(automergeDocId, khDocId);
    // Eagerly prime the Document object cache so the first encrypt doesn't stall
    void this.getOrFetchDocument(automergeDocId);
    // Retry any buffered messages that were encrypted for this doc before the mapping existed
    this.retryPendingDecrypt();
  }

  /** Fetch (and cache) the keyhive Document for a given automerge doc ID. */
  private async getOrFetchDocument(automergeDocId: string): Promise<KeyhiveDocument | null> {
    const cached = this.docObjects.get(automergeDocId);
    if (cached) return cached;
    const khDocId = this.docMap.get(automergeDocId);
    if (!khDocId) return null;
    const doc = await this.keyhive.getDocument(khDocId);
    if (doc) this.docObjects.set(automergeDocId, doc);
    return doc ?? null;
  }

  /** Encrypt `data` bytes for a registered document. Returns flagged ciphertext or null on failure. */
  private async encryptPayload(automergeDocId: string, data: Uint8Array): Promise<Uint8Array | null> {
    const doc = await this.getOrFetchDocument(automergeDocId);
    if (!doc) return null;
    try {
      const hashBuf = await crypto.subtle.digest('SHA-256', data as unknown as BufferSource);
      const contentRef = new ChangeId(new Uint8Array(hashBuf));
      const predRef = this.lastChangeIdByDoc.get(automergeDocId);
      // Delete before tryEncrypt: see inline encrypt block comment for rationale.
      this.docObjects.delete(automergeDocId);
      this.lastChangeIdByDoc.set(automergeDocId, new ChangeId(new Uint8Array(hashBuf)));
      const result = await this.keyhive.tryEncrypt(doc, contentRef, predRef ? [predRef] : [], data);
      if (result.update_op()) {
        // CGKA key rotation — force a full sync so the new op reaches all peers
        this.invalidateCaches();
        for (const peer of this.peers.values()) peer.forceFullSync = true;
        setTimeout(() => this.syncKeyhive(), 0);
      }
      const encBytes = result.encrypted_content().toBytes();
      const out = new Uint8Array(1 + encBytes.length);
      out[0] = ENC_ENCRYPTED;
      out.set(encBytes, 1);
      return out;
    } catch (e) {
      console.error(`[AMRepoKeyhive] encryptPayload failed for doc ${automergeDocId}:`, e);
      return null;
    }
  }

  /** Decrypt a flagged payload. Returns plaintext bytes or null on failure. */
  private async decryptPayload(automergeDocId: string, flaggedData: Uint8Array): Promise<Uint8Array | null> {
    if (flaggedData.length === 0) return flaggedData;
    if (flaggedData[0] !== ENC_ENCRYPTED) return null;
    const doc = await this.getOrFetchDocument(automergeDocId);
    if (!doc) {
      console.error(`[AMRepoKeyhive] decryptPayload: no keyhive doc for ${automergeDocId}`);
      return null;
    }
    try {
      const encrypted = (Encrypted as any).fromBytes(flaggedData.slice(1));
      return await this.keyhive.tryDecrypt(doc, encrypted);
    } catch (e) {
      console.error(`[AMRepoKeyhive] decryptPayload failed for doc ${automergeDocId}:`, e);
      return null;
    }
  }

  send(message: Message, contactCard?: ContactCard): void {
    if (this.peerId === undefined) {
      throw new Error("peerId must be defined!");
    }
    void this.asyncSignAndSend(message, contactCard);
  }

  async asyncSignAndSend(
    message: Message,
    contactCard?: ContactCard
  ): Promise<void> {
    if (this.peerId === undefined) {
      throw new Error("peerId must be defined!");
    }
    let data: Uint8Array =
      "data" in message && message.data !== undefined
        ? message.data
        : new Uint8Array();
    const seqNumber = this.pending.register();
    try {
      // Pre-compute SHA-256 hash outside WASM (native crypto API, safe to call concurrently)
      const automergeDocId = (message as any).documentId as string | undefined;
      const targetId = (message as any).targetId as PeerId | undefined;
      // Don't encrypt for peers who haven't completed keyhive sync — they don't
      // have the CGKA keys yet and would buffer/drop the message. After keyhive
      // sync confirms, keyhiveSynced becomes true and encryption kicks in.
      const peerReady = !targetId || (this.peers.get(targetId)?.keyhiveSynced !== false);
      const shouldEncrypt =
        automergeDocId !== undefined &&
        this.docMap.has(automergeDocId) &&
        (message.type === "sync" || message.type === "change") &&
        data.length > 0 &&
        peerReady;
      if (automergeDocId && (message.type === "sync" || message.type === "change")) {
        debug(`SYNC-SEND: ${message.type} doc=${automergeDocId} target=${(message as any).targetId ?? 'n/a'} shouldEncrypt=${shouldEncrypt} dataLen=${data.length}`);
      }
      let hashBuf: ArrayBuffer | undefined;
      if (shouldEncrypt) {
        hashBuf = await crypto.subtle.digest('SHA-256', data as unknown as BufferSource);
      }
      // Encrypt (if applicable) and sign in a single queue slot to prevent concurrent WASM access
      const signedData = await this.keyhiveQueue.run(async () => {
        let payload = data;
        if (shouldEncrypt && hashBuf && automergeDocId) {
          let doc = this.docObjects.get(automergeDocId);
          if (!doc) {
            const khDocId = this.docMap.get(automergeDocId);
            if (khDocId) {
              const fetched = await this.keyhive.getDocument(khDocId);
              if (fetched) { this.docObjects.set(automergeDocId, fetched); doc = fetched; }
            }
          }
          if (doc) {
            try {
              const contentRef = new ChangeId(new Uint8Array(hashBuf));
              const predRef = this.lastChangeIdByDoc.get(automergeDocId);
              // Delete before tryEncrypt: tryEncrypt synchronously calls __destroy_into_raw()
              // on doc, zeroing its ptr. If tryEncrypt then rejects, the ptr=0 wrapper must
              // not remain in docObjects (it would panic on the next call).
              this.docObjects.delete(automergeDocId);
              this.lastChangeIdByDoc.set(automergeDocId, new ChangeId(new Uint8Array(hashBuf)));
              const result = await this.keyhive.tryEncrypt(doc, contentRef, predRef ? [predRef] : [], data);
              if (result.update_op()) {
                // New CGKA op generated — force a full sync so the new op reaches all peers
                this.invalidateCaches();
                for (const peer of this.peers.values()) peer.forceFullSync = true;
                setTimeout(() => this.syncKeyhive(), 0);
              }
              const encBytes = result.encrypted_content().toBytes();
              payload = new Uint8Array(1 + encBytes.length);
              payload[0] = ENC_ENCRYPTED;
              payload.set(encBytes, 1);
              debug(`Encrypted outgoing ${message.type} for doc ${automergeDocId}, updateOp=${result.update_op()}`);
            } catch (e) {
              console.error(`[AMRepoKeyhive] encryptPayload failed for doc ${automergeDocId}:`, e);
            }
          } else {
            console.error(`[AMRepoKeyhive] could not fetch keyhive doc for ${automergeDocId}, sending unencrypted`);
          }
        }
        return signData(this.keyhive, payload, contactCard);
      });
      await this.networkAdapter.whenReady();
      this.pending.fire(seqNumber, () => {
        // Ensure senderId matches the signing key. Automerge-repo preserves the
        // original senderId when forwarding ephemeral messages between adapters,
        // but the keyhive adapter signs with its own key — so senderId must match.
        message.senderId = this.peerId!;
        message.data = signedData;
        this.networkAdapter.send(message);
      });
    } catch (error) {
      console.error(
        `[AMRepoKeyhive] asyncSignAndSend FAILED for seq=${seqNumber}, type=${message.type}:`,
        error
      );
      this.pending.cancel(seqNumber);
    }
  }

  // Check if a peer has write access to a document via the keyhive access graph.
  // Returns true if: no keyhive doc registered (unshared), or peer has admin/write access.
  // Returns false if peer has read/pull/no access.
  private async peerHasWriteAccess(senderId: PeerId, automergeDocId: string): Promise<boolean> {
    const khDocId = this.docMap.get(automergeDocId);
    if (!khDocId) {
      // No keyhive doc registered — unshared doc, allow all
      return true;
    }
    try {
      const senderIdentifier = keyhiveIdentifierFromPeerId(senderId);
      const access = await this.keyhive.accessForDoc(senderIdentifier, khDocId);
      if (!access) {
        console.warn(`[AMRepoKeyhive] No access found for peer ${senderId} on doc ${automergeDocId} — blocking sync`);
        return false;
      }
      const accessStr = access.toString();
      const canWrite = accessStr === "Admin" || accessStr === "Write";
      if (!canWrite) {
        console.warn(`[AMRepoKeyhive] Peer ${senderId} has ${accessStr} access on doc ${automergeDocId} — blocking sync`);
      }
      return canWrite;
    } catch (err) {
      console.warn(`[AMRepoKeyhive] Access check failed for peer ${senderId} on doc ${automergeDocId}:`, err);
      // On error, block by default for safety
      return false;
    }
  }

  // Async wrapper that checks write access before emitting a sync message
  private async checkAccessAndEmit(message: Message): Promise<void> {
    const docId = (message as any).documentId as string;
    const hasAccess = await this.keyhiveQueue.run(() =>
      this.peerHasWriteAccess(message.senderId, docId)
    );
    if (hasAccess) {
      debug(`ACCESS-OK: emitting ${message.type} from ${message.senderId} for doc ${docId}`);
      this.emit("message", message);
    } else {
      console.warn(`[AMRepoKeyhive] DROPPED sync message from ${message.senderId} for doc ${docId} (insufficient access)`);
    }
  }

  private _rcvCount = 0;
  receiveMessage(message: Message): void {
    if (KH_DEBUG && (++this._rcvCount <= 20 || this._rcvCount % 50 === 0)) {
      debug(`receiveMessage #${this._rcvCount}: type=${message.type} from=${message.senderId} doc=${(message as any).documentId ?? 'n/a'}`);
    }
    try {
      if (
        this.hardcodedRemoteId &&
        message.senderId !== this.hardcodedRemoteId
      ) {
        debug(
          `Unknown remote peer ${message.senderId}. Ignoring message!`
        );
        return;
      }
      if (!("data" in message) || message.data === undefined) {
        this.emit("message", message);
        return;
      }
      // Messages from non-keyhive peers (e.g. relay server) aren't signed — pass through
      if (!isKeyhivePeerId(message.senderId)) {
        this.emit("message", message);
        return;
      }
      const maybeKeyhiveMessageData = decodeKeyhiveMessageData(message.data);
      if (maybeKeyhiveMessageData) {
        // Verify inside the queue to prevent concurrent WASM access (verify() is a WASM call)
        void this.keyhiveQueue.run(async () => {
          if (verifyData(message.senderId, maybeKeyhiveMessageData)) {
            if (!message.type?.startsWith("keyhive-")) {
              if (this.isBatching()) {
                this.keyhiveMsgBatch.countNonKeyhive();
              } else {
                this.streamingMetrics.recordNonKeyhive();
              }
              const rawPayload = maybeKeyhiveMessageData.signed.payload;
              // Check write access before emitting sync messages to the repo.
              // With a relay server, senderId is the original peer (not the server),
              // so we can verify the sender has write permission for this document.
              const automergeDocId = (message as any).documentId as string | undefined;
              const isEncrypted = rawPayload && rawPayload.length > 0 && rawPayload[0] === ENC_ENCRYPTED;
              const inDocMap = automergeDocId ? this.docMap.has(automergeDocId) : false;
              if (KH_DEBUG && automergeDocId && (message.type === "sync" || message.type === "change")) {
                debug(`SYNC-RCV: ${message.type} from=${message.senderId} doc=${automergeDocId} encrypted=${isEncrypted} inDocMap=${inDocMap} pendingDecrypt=${this.pendingDecrypt.length}`);
              }
              if (automergeDocId && inDocMap &&
                  (message.type === "sync" || message.type === "change") &&
                  isEncrypted) {
                // Decrypt inside the queue to prevent concurrent WASM access
                void this.keyhiveQueue.run(async () => {
                  debug(`DECRYPT-TASK: starting for doc=${automergeDocId} type=${message.type} from=${message.senderId}`);
                  try {
                    let doc = this.docObjects.get(automergeDocId);
                    if (!doc) {
                      // Cache miss — fetch now (inside queue to avoid concurrent WASM access)
                      const khDocId = this.docMap.get(automergeDocId);
                      debug(`DECRYPT-TASK: cache miss, khDocId=${khDocId}`);
                      if (khDocId) {
                        const fetched = await this.keyhive.getDocument(khDocId);
                        if (fetched) {
                          this.docObjects.set(automergeDocId, fetched);
                          doc = fetched;
                        }
                      }
                    }
                    if (!doc) {
                      console.error(`[AMRepoKeyhive] decryptPayload: no keyhive doc for ${automergeDocId}, dropping message`);
                      return;
                    }
                    try {
                      const encrypted = (Encrypted as any).fromBytes(rawPayload.slice(1));
                      const decrypted = await this.keyhive.tryDecrypt(doc, encrypted);
                      if (!decrypted) {
                        console.error(`[AMRepoKeyhive] tryDecrypt returned null for doc ${automergeDocId}, dropping message`);
                        return;
                      }
                      message.data = decrypted;
                      debug(`Decrypted ${message.type} for doc ${automergeDocId}`);
                      if (message.type === "sync" || message.type === "request") {
                        void this.checkAccessAndEmit(message);
                      } else {
                        this.emit("message", message);
                      }
                    } catch (e: any) {
                      // Decryption failed (key not yet available) — buffer for retry after keyhive sync
                      const errDetail = typeof e?.message === 'function' ? e.message() : (e?.message ?? String(e));
                      console.warn(`[AMRepoKeyhive] decryptPayload failed for doc ${automergeDocId}, buffering for retry (${this.pendingDecrypt.length + 1} pending): ${errDetail}`);
                      this.pendingDecrypt.push({ message, rawPayload, automergeDocId, retries: 0 });
                    }
                  } catch (outerErr: any) {
                    console.error(`[AMRepoKeyhive] DECRYPT-TASK: unexpected error for doc=${automergeDocId}:`, outerErr);
                  }
                });
              } else if (rawPayload && rawPayload.length > 0 && rawPayload[0] === ENC_ENCRYPTED) {
                // Encrypted payload but doc mapping not yet registered (timing race).
                // Buffer for retry — do NOT pass encrypted bytes to automerge.
                if (automergeDocId) {
                  console.warn(`[AMRepoKeyhive] encrypted msg for unmapped doc ${automergeDocId}, buffering for retry (${this.pendingDecrypt.length + 1} pending)`);
                  this.pendingDecrypt.push({ message, rawPayload, automergeDocId, retries: 0 });
                } else {
                  console.error(`[AMRepoKeyhive] encrypted msg with no documentId, dropping`);
                }
              } else {
                // Genuinely unencrypted payload (e.g. from server relay).
                message.data = rawPayload;
                this.emit("message", message);
              }
            } else if (this.isBatching()) {
              this.keyhiveMsgBatch.add(message, maybeKeyhiveMessageData);
            } else {
              this.streamingMetrics.recordMessage(
                message.type, message.senderId,
                maybeKeyhiveMessageData.signed.payload?.byteLength ?? 0,
              );
              const startTime = Date.now();
              const msgType = message.type ?? "unknown";
              void this.handleKeyhiveMessage(message, maybeKeyhiveMessageData, this.streamingMetrics).then(() => {
                this.streamingMetrics.recordProcessingTime(Date.now() - startTime);
                this.streamingMetrics.recordProcessingTimeByType(msgType, Date.now() - startTime);
              });
            }
          } else {
            console.error(
              `[AMRepoKeyhive] verifyData FAILED for type=${message.type} from=${message.senderId} doc=${(message as any).documentId}`
            );
          }
        });
      } else {
        // Peer has a keyhive-looking ID but its message isn't keyhive-signed
        // (e.g. relay server whose peerId prefix happens to decode as 32 bytes).
        // Treat the same as a non-keyhive peer — pass through as-is.
        debug(`[AMRepoKeyhive] Non-keyhive-signed message from ${message.senderId} type=${message.type}, passing through`);
        this.emit("message", message);
      }
    } catch (e) {
      console.error("[AMRepoKeyhive] Could not decode signed message:", e);
      return;
    }
  }

  private async handleKeyhiveMessage(
    message: Message,
    keyhiveMessageData: KeyhiveMessageData,
    metrics: Metrics,
  ) {
    if (keyhiveMessageData.contactCard) {
      await receiveContactCard(
        this.keyhive,
        keyhiveMessageData.contactCard,
        this.keyhiveStorage
      );
    }
    message.data = keyhiveMessageData.signed.payload;

    if (message.type === "keyhive-sync-request") {
      await this.sendKeyhiveSyncResponse(message, metrics);
    } else if (message.type === "keyhive-sync-response") {
      await this.sendKeyhiveSyncOps(message, metrics);
    } else if (message.type === "keyhive-sync-request-contact-card") {
      await this.sendKeyhiveSyncMissingContactCard(message);
    } else if (message.type === "keyhive-sync-missing-contact-card") {
      // Pass undefined so the sync loop doesn't skip the peer who just sent
      // their contact card — that's the peer we need to sync WITH.
      await this.syncKeyhive(undefined, true);
    } else if (message.type === "keyhive-sync-ops") {
      await this.receiveKeyhiveSyncOps(message, metrics);
    } else if (message.type === "keyhive-sync-check") {
      await this.handleKeyhiveSyncCheck(message, metrics);
    } else if (message.type === "keyhive-sync-confirmation") {
      await this.handleKeyhiveSyncConfirmation(message, metrics);
    } else {
      this.emit("message", message);
    }
  }

  syncKeyhive(
    maybeSenderId: PeerId | undefined = undefined,
    includeContactCard: boolean = false,
    attemptRecovery: boolean = false
  ): void {
    void this.asyncSyncKeyhive(
      maybeSenderId,
      includeContactCard,
      attemptRecovery
    );
  }

  // Trigger the keyhive op set reconciliation sync protocol. Determine the hashes
  // that are relevant for the given peer as well as any pending hashes on this
  // keyhive (any pending hash might be relevant). Then send a request to the
  // peer to begin the sync protocol.
  // This is the first keyhive op sync protocol message.
  private async asyncSyncKeyhive(
    maybeSenderId: PeerId | undefined,
    includeContactCard: boolean,
    attemptRecovery: boolean = false
  ): Promise<void> {
    if (this.peerId === undefined) {
      throw new Error("peerId must be defined!");
    }
    await this.keyhiveQueue.run(async () => {
      if (attemptRecovery) {
        debug(
          "[AMRepoKeyhive] Preparing for keyhive sync. Reading from storage"
        );
        try {
          const statsBefore = await this.keyhive.stats();
          await this.keyhiveStorage.ingestKeyhiveFromStorage(this.keyhive);
          // Check if ingestion changed state and invalidate cache if needed
          await this.checkAndInvalidateCache();
          // Emit ingest-remote if new ops were added from storage
          const statsAfter = await this.keyhive.stats();
          if (statsAfter.totalOps !== statsBefore.totalOps) {
            (this.emit as any)("ingest-remote");
            this.retryPendingDecrypt();
          }
        } catch (error) {
          console.error(`[AMRepoKeyhive] Unable to ingest from storage: ${error}`);
        }
      }
      let senderId: PeerId;
      if (maybeSenderId) {
        senderId = maybeSenderId;
      } else {
        senderId = this.peerId!;
      }

      // Get contact card once for all peers if needed, to avoid multiple rotations
      let maybeContactCard: ContactCard | undefined;
      if (includeContactCard) {
        debug("[AMRepoKeyhive] Including Contact Card in sync message.")
        maybeContactCard = this.contactCard;
      }

      debug(`[AMRepoKeyhive] Syncing with ${this.peers.size} peers`);
      for (const targetId of this.peers.keys()) {
        if (targetId == senderId || targetId == this.peerId!) {
          continue;
        }
        if (!isKeyhivePeerId(targetId)) {
          continue; // Skip non-keyhive peers (e.g. relay server)
        }
        if (!this.readyToSendKeyhiveRequest(targetId)) {
          debug(`[AMRepoKeyhive] Attempted to send keyhive sync request to ${targetId} too soon. Ignoring.`);
          continue;
        }

        // Check if we know the target agent (WASM keyhive is authoritative)
        const targetKeyhiveId = keyhiveIdentifierFromPeerId(targetId);
        const targetAgent = await this.keyhive.getAgent(targetKeyhiveId);
        if (!targetAgent) {
          debug(`[AMRepoKeyhive] Requesting ContactCard from ${targetId}`);
          if (!maybeContactCard) {
            maybeContactCard = this.contactCard;
          }
          const message = {
            type: "keyhive-sync-request-contact-card",
            senderId: senderId,
            targetId: targetId,
          };
          this.send(message, maybeContactCard);
        } else {
          const peer = this.peers.get(targetId);
          if (peer?.beliefCounts !== null && peer !== undefined && !peer.forceFullSync) {
            // Shortcut: send lightweight sync check instead of full request
            const hashes = await this.getHashesForPeerPair(senderId, targetId);
            const pendingOpHashes = await this.getCachedPendingOpHashes();
            const myTotal = hashes.size + pendingOpHashes.length;
            const data = encode({
              myTotal,
              beliefOfTheirTotal: peer.beliefCounts.theirTotalForMe,
            });
            const message = {
              type: "keyhive-sync-check",
              senderId: senderId,
              targetId: targetId,
              data: data,
            };
            // BUG1 DIAGNOSTIC: check for staleness on every sync check (bypasses all caches)
            {
              const pubAgent = await this.keyhive.getAgent(Identifier.publicId());
              if (pubAgent) {
                const rawHashes = await this.keyhive.eventHashesForAgent(pubAgent);
                const rawEvents = await this.keyhive.eventsForAgent(pubAgent);
                const stats = await this.keyhive.stats();
                if (rawHashes.length !== rawEvents.size) {
                  console.error(`[BUG1] STALE at sync-check! eventHashesForAgent=${rawHashes.length} eventsForAgent=${rawEvents.size} totalOps=${stats.totalOps} myTotal=${myTotal}`);
                }
              }
            }
            debug(
              `[AMRepoKeyhive] Sending keyhive sync check to ${targetId} from ${senderId}: myTotal=${myTotal}, beliefOfTheirTotal=${peer.beliefCounts.theirTotalForMe}`
            );
            this.streamingMetrics.recordSyncCheckSent();
            this.send(message, maybeContactCard);
          } else {
            // No belief yet (or forceFullSync) — send full sync request
            if (peer) peer.forceFullSync = false;
            const hashes = await this.getHashesForPeerPair(senderId, targetId);
            const opHashes = Array.from(hashes.values());
            const pendingOpHashes = await this.getCachedPendingOpHashes();
            const data = encode({
              found: opHashes,
              pending: pendingOpHashes,
            });
            const message = {
              type: "keyhive-sync-request",
              senderId: senderId,
              targetId: targetId,
              data: data,
            };
            console.log(
              `[AMRepoKeyhive] Sending FULL keyhive sync request to ${targetId} with ${opHashes.length} hashes and ${pendingOpHashes.length} pending`
            );
            this.send(message, maybeContactCard);
          }
        }
        const peer = this.peers.get(targetId);
        if (peer) {
          peer.lastKeyhiveRequestSent = new Date();
        }
      }
    });
  }

  // Send a response to a request from a peer to initiate the keyhive op set
  // reconciliation sync protocol. Given the hashes sent by the peer, determine
  // which ops to send them. Then determine any missing ops to request from the
  // peer.
  // This is the second keyhive op sync protocol message.
  private async sendKeyhiveSyncResponse(message: Message, metrics: Metrics): Promise<void> {
    if (!("data" in message) || !message.data) {
      console.error("[AMRepoKeyhive] Expected data in keyhive-sync-request");
      return;
    }
    if (message.type !== "keyhive-sync-request") {
      console.error(
        `[AMRepoKeyhive] Expected keyhive-sync-request, but got ${message.type}`
      );
      return;
    }
    if (this.peerId === undefined) {
      throw new Error("peerId must be defined!");
    }
    const peerId = this.peerId;

    const requestData = decode(message.data as Uint8Array);
    const peerFoundHashes: Uint8Array[] = requestData.found || [];
    const peerPendingHashes: Uint8Array[] = requestData.pending || [];

    debug(
      `[AMRepoKeyhive] Received keyhive sync request from ${message.senderId} with ${peerFoundHashes.length} found hashes, ${peerPendingHashes.length} pending hashes`
    );

    const queueEnterTime = Date.now();
    await this.keyhiveQueue.run(async () => {
      metrics.recordQueueWait(Date.now() - queueEnterTime);
      if (!this.readyToSendKeyhiveResponse(message.senderId)) {
        debug(`[AMRepoKeyhive] Received next keyhive sync request too soon from ${message.senderId}. Ignoring.`);
        return;
      }

      // Check if we know the sender agent (WASM keyhive is authoritative)
      const senderKeyhiveId = keyhiveIdentifierFromPeerId(message.senderId);
      const senderAgent = await this.keyhive.getAgent(senderKeyhiveId);
      if (!senderAgent) {
        debug(
          `[AMRepoKeyhive] No agent found for ${message.senderId}, sending keyhive-sync-missing-contact-card`
        );
        const response = {
          type: "keyhive-sync-request-contact-card",
          senderId: peerId,
          targetId: message.senderId,
        };
        this.send(response, this.contactCard);
      } else {
        // Agent is known — use cache for hashes (may be empty if cache hasn't caught up)
        const localHashes = await this.getHashesForPeerPair(peerId, message.senderId, metrics);
        const pendingOpHashes = await this.getCachedPendingOpHashes(metrics);
        debug(
          `[AMRepoKeyhive] asyncSendKeyhiveSyncResponse: Found ${localHashes.size} total local operation hashes for ${message.senderId} and ${pendingOpHashes.length} total pending hashes`
        );

        // Build map to look up peer found hashes by string
        const peerFoundByHashString = new Map<string, Uint8Array>();
        for (const hash of peerFoundHashes) {
          peerFoundByHashString.set(hash.toString(), hash);
        }

        const pendingHashStrings = new Set(
          pendingOpHashes.map((h) => h.toString())
        );
        // Merge peer pending into found for "to send" computation — the peer
        // already has bytes for pending events, so don't re-send them.
        // But don't request pending events — peers can't serve them.
        const peerPendingHashStrings = new Set(
          peerPendingHashes.map((h) => h.toString())
        );
        const localHashStrings = new Set(localHashes.keys());
        const peerFoundHashStrings = new Set(peerFoundByHashString.keys());

        // Determine which ops we need to send to the peer
        const hashStringsToSend = localHashStrings.difference(
          peerFoundHashStrings.union(peerPendingHashStrings)
        );

        // Determine which ops we need to request from the peer (only from found, not pending)
        const hashStringsToRequest = peerFoundHashStrings.difference(
          localHashStrings.union(pendingHashStrings)
        );
        const requested = Array.from(hashStringsToRequest)
          .map((str) => peerFoundByHashString.get(str))
          .filter((hash) => hash !== undefined);

        // Only fetch full events if we have ops to send
        let foundResult: EventBytesResult = { events: [], cborEvents: [] };
        if (hashStringsToSend.size > 0) {
          foundResult = await this.getEventBytesForHashes(peerId, hashStringsToSend, metrics);
        }

        metrics.recordOpsSent(foundResult.events.length);
        metrics.recordOpsRequested(requested.length);

        debug(
          `[AMRepoKeyhive] Found ${foundResult.events.length} ops to send to and ${requested.length} ops to request from ${message.senderId}`
        );
        debug(`sync-response: sending=${foundResult.events.length} requesting=${requested.length} peer=${message.senderId.slice(0,20)}`);

        // Metadata for belief tracking
        const senderTotal = localHashes.size + pendingOpHashes.length;
        const receiverTotal = peerFoundHashes.length + peerPendingHashes.length;
        const data = buildSyncResponseCbor(requested, foundResult.cborEvents, senderTotal, receiverTotal);
        const response = {
          type: "keyhive-sync-response",
          senderId: peerId,
          targetId: message.senderId,
          data,
        };
        debug(
          `[AMRepoKeyhive] Sending keyhive sync response to ${message.senderId} from ${peerId}`
        );
        this.send(response);
      }
      const peer = this.peers.get(message.senderId);
      if (peer) {
        peer.lastKeyhiveRequestRcvd = new Date();
      }
    });
  }

  // Send requested ops in response to a keyhive sync response. Look up ops
  // for the requested hashes and send them to the requesting peer.
  // This is the third (and final) keyhive op sync protocol message.
  private async sendKeyhiveSyncOps(message: Message, metrics: Metrics): Promise<void> {
    if (!("data" in message) || !message.data) {
      console.error("[AMRepoKeyhive] Expected data in keyhive-sync-response");
      return;
    }
    if (message.type !== "keyhive-sync-response") {
      console.error(
        `[AMRepoKeyhive] Expected keyhive-sync-response, but got ${message.type}`
      );
      return;
    }
    if (this.peerId === undefined) {
      throw new Error("peerId must be defined!");
    }
    const peerId = this.peerId;

    const responseData = decode(message.data as Uint8Array);
    const requestedHashes: Uint8Array[] = responseData.requested || [];
    const foundEvents: Uint8Array[] = responseData.found || [];
    const responseSenderTotal: number | undefined = responseData.senderTotal;
    const responseReceiverTotal: number | undefined = responseData.receiverTotal;

    debug(
      `[AMRepoKeyhive] Received keyhive sync response from ${message.senderId}: ${foundEvents.length} ops found, ${requestedHashes.length} ops requested`
    );

    const queueEnterTime = Date.now();
    await this.keyhiveQueue.run(async () => {
      metrics.recordQueueWait(Date.now() - queueEnterTime);
      if (foundEvents.length > 0) {
        debug(
          `[AMRepoKeyhive] Ingesting ${foundEvents.length} keyhive events from ${message.senderId}`
        );

        try {
          let pendingEvents: any[] | null = null;
          try {
            pendingEvents = await this.keyhive.ingestEventsBytes(foundEvents);
          } catch (error) {
            console.error(`[AMRepoKeyhive] Error ingesting events: ${error}`);
          }

          if (pendingEvents) {
            metrics.recordIngestion(foundEvents.length, pendingEvents.length);
            debug(
              `[AMRepoKeyhive] After ingestion: ${pendingEvents.length} pending events`
            );
          }

          // If there are pending events or something went wrong ingesting, try reading from
          // storage (e.g., in case they have already been processed by a separate tab in a
          // browser).
          if (!pendingEvents || pendingEvents.length > 0) {
            if (pendingEvents) {
              debug(
                `${pendingEvents.length} events stuck in pending${this.retryPendingFromStorage ? ". Reading from storage" : ""}`
              );
            }
            if (this.retryPendingFromStorage) {
              metrics.recordStorageRetry();
              try {
                await this.keyhiveStorage.ingestKeyhiveFromStorage(this.keyhive);
                const retryPending =
                  await this.keyhive.ingestEventsBytes(foundEvents);
                if (retryPending.length === 0) {
                  debug(
                    `Successfully ingested all events after reading from storage`
                  );
                } else {
                  debug(
                    `Still have ${retryPending.length} pending events after reading from storage`
                  );
                }
              } catch (storageError) {
                console.error(
                  `[AMRepoKeyhive] Failed while reading from storage:`,
                  storageError
                );
              }
            }
          }

          void this.saveReceivedEvents(foundEvents);
          // Invalidate/refresh cache since we ingested events from a peer
          if (this.opCache) {
            void this.opCache.refresh(this.keyhive);
          } else {
            this.invalidateCaches();
          }
          const statsAfterIngest = await this.keyhive.stats();
          // BUG1 DIAGNOSTIC: check eventHashesForAgent consistency after ingestion
          {
            const pubAgent = await this.keyhive.getAgent(Identifier.publicId());
            if (pubAgent) {
              const hashes = await this.keyhive.eventHashesForAgent(pubAgent);
              const events = await this.keyhive.eventsForAgent(pubAgent);
              if (hashes.length !== events.size) {
                console.error(`[BUG1] STALE after sync-response ingest! eventHashesForAgent=${hashes.length} but eventsForAgent=${events.size}, totalOps=${statsAfterIngest.totalOps}`);
              } else {
                debug(`[BUG1] OK after sync-response ingest: hashes=${hashes.length}, events=${events.size}, totalOps=${statsAfterIngest.totalOps}`);
              }
            }
          }
          if (statsAfterIngest.totalOps !== this.lastKnownTotalOps) {
            debug(`ingest-remote (sync-response): totalOps changed ${this.lastKnownTotalOps} → ${statsAfterIngest.totalOps}, pendingDecrypt=${this.pendingDecrypt.length}`);
            this.lastKnownTotalOps = statsAfterIngest.totalOps;
            // Only clear beliefs when state actually changed
            this.invalidateBeliefs();
            (this.emit as any)("ingest-remote");
            this.retryPendingDecrypt();
          } else {
            debug(`ingest-remote SUPPRESSED (sync-response): totalOps unchanged at ${this.lastKnownTotalOps}, pendingDecrypt=${this.pendingDecrypt.length}`);
            // Even if no new ops, retry pending decrypts — CGKA key state may have changed
            this.retryPendingDecrypt();
          }
        } catch (error) {
          await this.handleIngestError(error, foundEvents, message.senderId);
        }
      }

      if (requestedHashes.length > 0) {
        const requestedHashStrings = new Set(
          requestedHashes.map((h) => h.toString())
        );
        const requestedResult = await this.getEventBytesForHashes(peerId, requestedHashStrings, metrics);

        if (requestedResult.events.length === 0) {
          debug(
            `[AMRepoKeyhive] 0 ops requested by ${message.senderId}`
          );
          // Fall through to confirmation below
        } else {
          if (requestedResult.events.length < requestedHashes.length) {
            debug(
              `${requestedHashes.length} keyhive events requested, ${requestedResult.events.length} found.`
            );
          }

          metrics.recordOpsSent(requestedResult.events.length);

          debug(
            `[AMRepoKeyhive] Sending ${requestedResult.events.length} requested ops to ${message.senderId}`
          );

          if (responseSenderTotal !== undefined && responseReceiverTotal !== undefined) {
            const data = buildSyncOpsCbor(requestedResult.cborEvents, responseSenderTotal, responseReceiverTotal);
            const response = {
              type: "keyhive-sync-ops",
              senderId: peerId,
              targetId: message.senderId,
              data,
            };
            this.send(response);
          } else {
            const data = buildCborByteStringArray(requestedResult.cborEvents);
            const response = {
              type: "keyhive-sync-ops",
              senderId: peerId,
              targetId: message.senderId,
              data,
            };
            this.send(response);
          }
          return;
        }
      }

      // No ops exchanged (or 0 found for requested) — send confirmation and establish beliefs
      if (responseSenderTotal !== undefined && responseReceiverTotal !== undefined) {
        const peer = this.peers.get(message.senderId);
        if (peer) {
          // receiverTotal is what the responder computed as our total for them
          peer.beliefCounts = {
            myTotalForThem: responseReceiverTotal,
            theirTotalForMe: responseSenderTotal,
          };
        }

        const confirmData = encode({
          myTotalForThem: responseReceiverTotal,
          theirTotalForMe: responseSenderTotal,
        });
        const confirmMsg = {
          type: "keyhive-sync-confirmation",
          senderId: peerId,
          targetId: message.senderId,
          data: confirmData,
        };
        metrics.recordSyncConfirmationSent();
        this.send(confirmMsg);
      }
    });
  }

  // In response to a message from a peer indicating they are missing our contact
  // card, send it along. This response will trigger a keyhive op sync.
  private async sendKeyhiveSyncMissingContactCard(
    message: Message
  ): Promise<void> {
    if (message.type !== "keyhive-sync-request-contact-card") {
      console.error(
        `[AMRepoKeyhive] Expected keyhive-sync-request-contact-card, but got ${message.type}`
      );
      return;
    }
    if (this.peerId === undefined) {
      throw new Error("peerId must be defined!");
    }

    debug(
      `[AMRepoKeyhive] Sending keyhive-sync-missing-contact-card to ${message.senderId}`
    );

    const response = {
      type: "keyhive-sync-missing-contact-card",
      senderId: this.peerId,
      targetId: message.senderId,
    };
    this.send(response, this.contactCard);
  }

  // Receive ops sent by a peer as part of the third (and final) keyhive ops
  // sync protocol message.
  private async receiveKeyhiveSyncOps(message: Message, metrics: Metrics): Promise<void> {
    if (!("data" in message) || !message.data) {
      console.error("[AMRepoKeyhive] Expected data in keyhive-sync-ops");
      return;
    }
    if (message.type !== "keyhive-sync-ops") {
      console.error(
        `[AMRepoKeyhive] Expected keyhive-sync-ops, but got ${message.type}`
      );
      return;
    }
    if (this.peerId === undefined) {
      throw new Error("peerId must be defined!");
    }

    const decoded = decode(message.data as Uint8Array);

    // Handle both old array format and new map format with metadata
    let receivedEvents: Uint8Array[];
    let opsSenderTotal: number | undefined;
    let opsReceiverTotal: number | undefined;
    if (Array.isArray(decoded)) {
      receivedEvents = decoded;
    } else {
      receivedEvents = decoded.ops || [];
      opsSenderTotal = decoded.senderTotal;
      opsReceiverTotal = decoded.receiverTotal;
    }

    debug(
      `[AMRepoKeyhive] Received ${receivedEvents.length} keyhive events`
    );

    const queueEnterTime = Date.now();
    await this.keyhiveQueue.run(async () => {
      metrics.recordQueueWait(Date.now() - queueEnterTime);
      if (receivedEvents.length > 0) {
        debug(
          `[AMRepoKeyhive] Ingesting ${receivedEvents.length} keyhive events from ${message.senderId}`
        );

        try {
          const pendingEvents =
            await this.keyhive.ingestEventsBytes(receivedEvents);
          metrics.recordIngestion(receivedEvents.length, pendingEvents.length);
          debug(
            `[AMRepoKeyhive] After ingestion: ${pendingEvents.length} pending events`
          );

          // If there are pending events, try reading from storage (e.g., in case
          // they have already been processed by a separate tab in a browser).
          if (pendingEvents.length > 0) {
            debug(
              `${pendingEvents.length} events stuck in pending${this.retryPendingFromStorage ? ". Reading from storage" : ""}`
            );
            if (this.retryPendingFromStorage) {
              metrics.recordStorageRetry();
              try {
                await this.keyhiveStorage.ingestKeyhiveFromStorage(this.keyhive);
                const retryPending =
                  await this.keyhive.ingestEventsBytes(receivedEvents);
                if (retryPending.length === 0) {
                  debug(
                    `Successfully ingested all events after reading from storage`
                  );
                } else {
                  debug(
                    `Still have ${retryPending.length} pending events after reading from storage`
                  );
                }
              } catch (storageError) {
                console.error(
                  `[AMRepoKeyhive] Failed while reading from storage:`,
                  storageError
                );
              }
            }
          }

          void this.saveReceivedEvents(receivedEvents);
          // Invalidate hash cache since we ingested events from a peer
          this.invalidateCaches();
          const statsAfterIngest = await this.keyhive.stats();
          // BUG1 DIAGNOSTIC: check eventHashesForAgent consistency after ingestion
          {
            const pubAgent = await this.keyhive.getAgent(Identifier.publicId());
            if (pubAgent) {
              const hashes = await this.keyhive.eventHashesForAgent(pubAgent);
              const events = await this.keyhive.eventsForAgent(pubAgent);
              if (hashes.length !== events.size) {
                console.error(`[BUG1] STALE after sync-ops ingest! eventHashesForAgent=${hashes.length} but eventsForAgent=${events.size}, totalOps=${statsAfterIngest.totalOps}`);
              } else {
                debug(`[BUG1] OK after sync-ops ingest: hashes=${hashes.length}, events=${events.size}, totalOps=${statsAfterIngest.totalOps}`);
              }
            }
          }
          if (statsAfterIngest.totalOps !== this.lastKnownTotalOps) {
            debug(`ingest-remote (sync-ops): totalOps changed ${this.lastKnownTotalOps} → ${statsAfterIngest.totalOps}, pendingDecrypt=${this.pendingDecrypt.length}`);
            this.lastKnownTotalOps = statsAfterIngest.totalOps;
            // Only clear beliefs when state actually changed
            this.invalidateBeliefs();
            (this.emit as any)("ingest-remote");
            this.retryPendingDecrypt();
          } else {
            debug(`ingest-remote SUPPRESSED (sync-ops): totalOps unchanged at ${this.lastKnownTotalOps}, pendingDecrypt=${this.pendingDecrypt.length}`);
            // Even if no new ops, retry pending decrypts — CGKA key state may have changed
            this.retryPendingDecrypt();
          }

          // After successful ingestion, send confirmation and establish beliefs
          if (opsSenderTotal !== undefined && opsReceiverTotal !== undefined) {
            const peer = this.peers.get(message.senderId);
            if (peer) {
              peer.beliefCounts = {
                myTotalForThem: opsSenderTotal,
                theirTotalForMe: opsReceiverTotal,
              };
              if (!peer.keyhiveSynced) {
                debug(`peer ${message.senderId} keyhive sync completed (sending confirmation), enabling encryption`);
                peer.keyhiveSynced = true;
              }
            }
            const confirmData = encode({
              myTotalForThem: opsSenderTotal,
              theirTotalForMe: opsReceiverTotal,
            });
            const confirmMsg = {
              type: "keyhive-sync-confirmation",
              senderId: this.peerId!,
              targetId: message.senderId,
              data: confirmData,
            };
            metrics.recordSyncConfirmationSent();
            this.send(confirmMsg);
          }
        } catch (error) {
          await this.handleIngestError(error, receivedEvents, message.senderId);
        }
      }
    });
  }

  // Handle a lightweight sync check message. If counts match our beliefs,
  // no sync is needed. Otherwise, fall back to a full sync request.
  private async handleKeyhiveSyncCheck(
    message: Message,
    metrics: Metrics,
  ): Promise<void> {
    if (!("data" in message) || !message.data) {
      console.error("[AMRepoKeyhive] Expected data in keyhive-sync-check");
      return;
    }
    if (this.peerId === undefined) {
      throw new Error("peerId must be defined!");
    }
    const peerId = this.peerId;

    const checkData = decode(message.data as Uint8Array);
    const theirTotal: number = checkData.myTotal;
    const theirBeliefOfOurTotal: number = checkData.beliefOfTheirTotal;

    metrics.recordSyncCheckReceived();

    const queueEnterTime = Date.now();
    await this.keyhiveQueue.run(async () => {
      metrics.recordQueueWait(Date.now() - queueEnterTime);

      let peer = this.peers.get(message.senderId);
      if (!peer) {
        // Auto-register the peer if we receive a sync check from an unknown
        // sender (can happen if the peer-candidate event was missed due to
        // timing/race conditions, e.g. MessageChannel adapters).
        debug(
          `[AMRepoKeyhive] Auto-registering peer from sync-check: ${message.senderId}`
        );
        peer = new Peer();
        this.peers.set(message.senderId, peer);
      }

      // Compute our actual total for the sender
      const hashes = await this.getHashesForPeerPair(peerId, message.senderId);
      const pendingOpHashes = await this.getCachedPendingOpHashes();
      const ourActualTotal = hashes.size + pendingOpHashes.length;

      // Check both conditions
      const ourBeliefMatchesTheirTotal = peer.beliefCounts !== null &&
        peer.beliefCounts.theirTotalForMe === theirTotal;
      const theirBeliefMatchesOurTotal = theirBeliefOfOurTotal === ourActualTotal;

      if (ourBeliefMatchesTheirTotal && theirBeliefMatchesOurTotal && peer.beliefCounts !== null) {
        debug(
          `[AMRepoKeyhive] Sync check passed for ${message.senderId}: both totals match (ours=${ourActualTotal}, theirs=${theirTotal})`
        );
        metrics.recordSyncCheckShortCircuited();
        return;
      }

      // Mismatch — fall back to full sync request
      debug(
        `[AMRepoKeyhive] Sync check failed for ${message.senderId}: mismatch (ourActual=${ourActualTotal}, theirBeliefOfOurs=${theirBeliefOfOurTotal}, theirTotal=${theirTotal}, ourBeliefOfTheirs=${peer.beliefCounts?.theirTotalForMe ?? "null"}). Falling back to full sync.`
      );
      metrics.recordSyncCheckFallback();

      const opHashes = Array.from(hashes.values());
      const data = encode({
        found: opHashes,
        pending: pendingOpHashes,
      });
      const request = {
        type: "keyhive-sync-request",
        senderId: peerId,
        targetId: message.senderId,
        data: data,
      };
      this.send(request);
      peer.lastKeyhiveRequestRcvd = new Date();
    });
  }

  // Handle a sync confirmation message. Update our beliefs about the sender's state.
  private async handleKeyhiveSyncConfirmation(
    message: Message,
    metrics: Metrics,
  ): Promise<void> {
    if (!("data" in message) || !message.data) {
      console.error("[AMRepoKeyhive] Expected data in keyhive-sync-confirmation");
      return;
    }

    const confirmData = decode(message.data as Uint8Array);
    const theirTotalForUs: number = confirmData.myTotalForThem;
    const theirBeliefOfOurTotal: number = confirmData.theirTotalForMe;

    metrics.recordSyncConfirmationReceived();

    const peer = this.peers.get(message.senderId);
    if (peer) {
      peer.beliefCounts = {
        myTotalForThem: theirBeliefOfOurTotal,
        theirTotalForMe: theirTotalForUs,
      };
      if (!peer.keyhiveSynced) {
        debug(`peer ${message.senderId} keyhive sync confirmed, enabling encryption`);
        peer.keyhiveSynced = true;
      }
      debug(
        `[AMRepoKeyhive] Updated beliefs for ${message.senderId}: myTotalForThem=${theirBeliefOfOurTotal}, theirTotalForMe=${theirTotalForUs}`
      );
    }

    // After a keyhive sync round completes, CGKA keys may now be available
    // that weren't before (e.g. after a new member's ops are ingested).
    this.retryPendingDecrypt();
  }

  private async saveReceivedEvents(events: Uint8Array[]): Promise<void> {
    for (const event of events) {
      try {
        await this.keyhiveStorage.saveEventBytesWithHash(event);
      } catch (error) {
        console.error("[AMRepoKeyhive] Failed to save received event:", error);
      }
    }
    debug(
      `[AMRepoKeyhive] Saved ${events.length} received events to storage`
    );
  }

  private async handleIngestError(
    error: unknown,
    events: Uint8Array[],
    senderId: PeerId
  ): Promise<void> {
    // @ts-ignore
    const jsError =
      error && typeof error == "object" && "toError" in error
        ? // @ts-ignore
          error.toError()
        : error;

    const errorMessage =
      jsError instanceof Error ? jsError.message : String(jsError);

    console.error(
      `[AMRepoKeyhive] Error while ingesting events from ${senderId}: ${errorMessage}`
    );
  }

  private requestKeyhiveSync(): void {
    if (this.peerId === undefined) {
      return;
    }
    let includeContactCard = false;
    let attemptRecovery = true;
    this.syncKeyhive(this.peerId, includeContactCard, attemptRecovery);
  }

  private readyToSendKeyhiveRequest(targetId: PeerId): boolean {
    const now = new Date().getTime();
    const lastKeyhiveRequestSent: Date | undefined = this.peers.get(targetId)?.lastKeyhiveRequestSent;
    if (!lastKeyhiveRequestSent) {
      return true
    }
    return (now - lastKeyhiveRequestSent.getTime()) > this.minSyncRequestInterval
  }

  private readyToSendKeyhiveResponse(senderId: PeerId): boolean {
    const now = new Date().getTime();
    const lastKeyhiveRequestRcvd: Date | undefined = this.peers.get(senderId)?.lastKeyhiveRequestRcvd;
    if (!lastKeyhiveRequestRcvd) {
      return true
    }
    return (now - lastKeyhiveRequestRcvd.getTime()) > this.minSyncResponseInterval
  }

  private runCompaction(): void {
    void this.keyhiveQueue.run(async () => {
      await this.keyhiveStorage.compact(this.keyhive);
    });
  }

  private static readonly MAX_DECRYPT_RETRIES = 50;

  /** Retry buffered messages that previously failed decryption. Called after keyhive sync ingests new events. */
  private retryPendingDecrypt(): void {
    if (this.pendingDecrypt.length === 0) return;
    const pending = this.pendingDecrypt.splice(0);
    debug(`retrying ${pending.length} buffered decrypt messages`);
    // Clear cached doc objects so we get fresh ones with new keys
    this.docObjects.clear();
    for (const entry of pending) {
      const { message, rawPayload, automergeDocId } = entry;
      void this.keyhiveQueue.run(async () => {
        let doc = this.docObjects.get(automergeDocId);
        if (!doc) {
          const khDocId = this.docMap.get(automergeDocId);
          if (khDocId) {
            const fetched = await this.keyhive.getDocument(khDocId);
            if (fetched) {
              this.docObjects.set(automergeDocId, fetched);
              doc = fetched;
            }
          }
        }
        if (!doc) {
          // Doc mapping still not available — re-buffer if under retry limit
          if (entry.retries < KeyhiveNetworkAdapter.MAX_DECRYPT_RETRIES) {
            entry.retries++;
            this.pendingDecrypt.push(entry);
          } else {
            console.warn(`[AMRepoKeyhive] dropping buffered msg for unmapped doc ${automergeDocId} after ${entry.retries} retries`);
          }
          return;
        }
        try {
          const encrypted = (Encrypted as any).fromBytes(rawPayload.slice(1));
          debug(`RETRY-DECRYPT: attempt ${entry.retries + 1} for doc ${automergeDocId} from ${message.senderId}`);
          const decrypted = await this.keyhive.tryDecrypt(doc, encrypted);
          if (!decrypted) {
            console.warn(`[AMRepoKeyhive] RETRY-DECRYPT: tryDecrypt returned null for doc ${automergeDocId}`);
            return;
          }
          message.data = decrypted;
          // CGKA keys confirmed working — end grace period early
          debug(`retry decrypted ${message.type} for doc ${automergeDocId}`);
          if (message.type === "sync" || message.type === "request") {
            void this.checkAccessAndEmit(message);
          } else {
            this.emit("message", message);
          }
        } catch (e: any) {
          // Still can't decrypt — re-buffer if under retry limit
          const errDetail = typeof e?.message === 'function' ? e.message() : (e?.message ?? String(e));
          if (entry.retries < KeyhiveNetworkAdapter.MAX_DECRYPT_RETRIES) {
            entry.retries++;
            console.warn(`[AMRepoKeyhive] RETRY-DECRYPT failed for doc ${automergeDocId} (attempt ${entry.retries}/${KeyhiveNetworkAdapter.MAX_DECRYPT_RETRIES}): ${errDetail}`);
            this.pendingDecrypt.push(entry);
          } else {
            console.warn(`[AMRepoKeyhive] dropping undecryptable msg for doc ${automergeDocId} after ${entry.retries} retries: ${errDetail}`);
          }
        }
      });
    }
  }

  private invalidateCaches(): void {
    this.hashesCache.clear();
    this.publicHashesCache = null;
    this.publicEventsCache = null;
    this.pendingOpHashesCache = null;
  }

  private invalidateBeliefs(): void {
    for (const peer of this.peers.values()) {
      peer.beliefCounts = null;
    }
  }

  // Check if keyhive state changed and invalidate/refresh cache if needed
  private async checkAndInvalidateCache(): Promise<void> {
    if (this.opCache) {
      await this.opCache.refresh(this.keyhive);
      return;
    }
    const stats = await this.keyhive.stats();
    const currentTotalOps = stats.totalOps;
    if (currentTotalOps !== this.lastKnownTotalOps) {
      debug(
        `[AMRepoKeyhive] Total ops changed from ${this.lastKnownTotalOps} to ${currentTotalOps}, invalidating cache`
      );
      this.lastKnownTotalOps = currentTotalOps;
      this.invalidateCaches();
    }
  }

  private async getCachedPendingOpHashes(metrics?: Metrics): Promise<Uint8Array[]> {
    if (this.opCache) {
      metrics?.recordCacheHit();
      return this.opCache.getPendingOpHashes();
    }
    if (this.cacheHashes && this.pendingOpHashesCache !== null) {
      metrics?.recordCacheHit();
      return this.pendingOpHashesCache;
    }
    if (this.cacheHashes) {
      metrics?.recordCacheMiss();
    }
    const hashes = await getPendingOpHashes(this.keyhive);
    if (this.cacheHashes) {
      this.pendingOpHashesCache = hashes;
    }
    return hashes;
  }

  private async getCachedPublicHashes(metrics?: Metrics): Promise<PeerHashes> {
    if (this.opCache) {
      metrics?.recordCacheHit();
      return this.opCache.getPublicHashes();
    }
    if (this.cacheHashes && this.publicHashesCache !== null) {
      metrics?.recordCacheHit();
      return this.publicHashesCache;
    }
    if (this.cacheHashes) {
      metrics?.recordCacheMiss();
    }
    const agent = await this.keyhive.getAgent(Identifier.publicId());
    let hashes: PeerHashes;
    if (!agent) {
      debug(`[DIAG getCachedPublicHashes] getAgent(publicId) returned null`);
      hashes = new Map();
    } else {
      hashes = await getEventHashesForAgent(this.keyhive, agent);
    }
    if (this.cacheHashes) {
      this.publicHashesCache = hashes;
    }
    return hashes;
  }

  private async getCachedPublicEvents(): Promise<Map<Uint8Array, any>> {
    if (this.cacheHashes && this.publicEventsCache !== null) {
      return this.publicEventsCache;
    }
    const agent = await this.keyhive.getAgent(Identifier.publicId());
    const events = agent
      ? await getEventsForAgent(this.keyhive, agent)
      : new Map<Uint8Array, any>();
    if (this.cacheHashes) {
      this.publicEventsCache = events;
    }
    return events;
  }

  // Get event hashes for a peer. Returns null if the peer agent is unknown.
  private async getHashesForPeer(peerId: PeerId, metrics?: Metrics): Promise<PeerHashes | null> {
    if (this.opCache) {
      const keyhiveId = keyhiveIdentifierFromPeerId(peerId);
      const agentIdStr = keyhiveId.toBytes().toString();
      const cached = this.opCache.getHashesForAgent(agentIdStr);
      if (cached) {
        metrics?.recordCacheHit();
        return cached;
      }
      // Agent not in cache — might be unknown or cache stale
      metrics?.recordCacheMiss();
      return null;
    }

    if (this.cacheHashes) {
      const cached = this.hashesCache.get(peerId);
      if (cached) {
        metrics?.recordCacheHit();
        return cached;
      }
      metrics?.recordCacheMiss();
    }

    const keyhiveId = keyhiveIdentifierFromPeerId(peerId);
    const agent = await this.keyhive.getAgent(keyhiveId);
    if (!agent) {
      return null;
    }
    const hashes = await getEventHashesForAgent(this.keyhive, agent);

    if (this.cacheHashes && hashes) {
      this.hashesCache.set(peerId, hashes);
    }
    return hashes;
  }

  // Returns union of hashes both peers can access, plus public hashes.
  // Using union (not intersection) ensures prerequisite events are included:
  // if event X is relevant to both peers but its prerequisite Y is only
  // relevant to one peer, Y must still be in the hash set so it can be
  // exchanged. Without Y, the receiving peer can't process X and it gets
  // stuck in their pending store forever.
  private async getHashesForPeerPair(
    peerA: PeerId,
    peerB: PeerId,
    metrics?: Metrics,
  ): Promise<PeerHashes> {
    const hashLookupStart = Date.now();
    const hashesForA = await this.getHashesForPeer(peerA, metrics) ?? new Map<string, Uint8Array>();
    const hashesForB = await this.getHashesForPeer(peerB, metrics) ?? new Map<string, Uint8Array>();

    const publicHashes = await this.getCachedPublicHashes(metrics);
    metrics?.recordHashLookupTime(Date.now() - hashLookupStart);

    const result = new Map<string, Uint8Array>(publicHashes);
    for (const [hashString, hashBytes] of hashesForA.entries()) {
      result.set(hashString, hashBytes);
    }
    for (const [hashString, hashBytes] of hashesForB.entries()) {
      result.set(hashString, hashBytes);
    }

    return result;
  }

  // Fetch full event bytes for a set of hashes, with pre-encoded CBOR byte strings
  private async getEventBytesForHashes(
    peerId: PeerId,
    hashStrings: Set<string>,
    metrics?: Metrics,
  ): Promise<EventBytesResult> {
    const eventLookupStart = Date.now();

    // Try OpCache first (sync server path)
    if (this.opCache) {
      const cached = this.opCache.getEventBytesForHashes(hashStrings);
      if (cached) {
        metrics?.recordEventLookupTime(Date.now() - eventLookupStart);
        return cached;
      }
      // Cache miss — fall through to WASM
      debug(`[AMRepoKeyhive] OpCache miss for ${hashStrings.size} hashes, falling back to WASM`);
    }

    // Check which hashes already have stored bytes and CBOR
    const events: Uint8Array[] = [];
    const cborEvents: Uint8Array[] = [];
    const missingHashes = new Set<string>();
    for (const hashStr of hashStrings) {
      const bytes = this.eventBytes.get(hashStr);
      const cbor = this.eventCborBytes.get(hashStr);
      if (bytes && cbor) {
        events.push(bytes);
        cborEvents.push(cbor);
      } else {
        missingHashes.add(hashStr);
      }
    }

    // If all requested hashes have stored bytes, skip WASM entirely
    if (missingHashes.size === 0) {
      metrics?.recordEventLookupTime(Date.now() - eventLookupStart);
      return { events, cborEvents };
    }

    // Fetch from WASM for misses
    const keyhiveId = keyhiveIdentifierFromPeerId(peerId);
    const agent = await this.keyhive.getAgent(keyhiveId);

    const wasmEvents = new Map<Uint8Array, any>();

    if (agent) {
      const peerEvents = await getEventsForAgent(this.keyhive, agent);
      for (const [hash, event] of peerEvents) {
        wasmEvents.set(hash, event);
      }
    }

    const publicEvents = await this.getCachedPublicEvents();
    for (const [hash, event] of publicEvents) {
      wasmEvents.set(hash, event);
    }

    // Store all fetched events and collect the ones we need
    for (const [hash, eventBytes] of wasmEvents.entries()) {
      const hashStr = hash.toString();
      if (!this.eventBytes.has(hashStr)) {
        this.eventBytes.set(hashStr, eventBytes);
        this.eventCborBytes.set(hashStr, cborByteString(eventBytes));
      }
      if (missingHashes.has(hashStr)) {
        events.push(eventBytes);
        cborEvents.push(this.eventCborBytes.get(hashStr)!);
      }
    }

    metrics?.recordEventLookupTime(Date.now() - eventLookupStart);
    return { events, cborEvents };
  }
}
