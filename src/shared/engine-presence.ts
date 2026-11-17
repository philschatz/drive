/**
 * Presence subsystem for DriveEngine (class-expression mixin over the core).
 *
 * Owns everything peer-awareness: the timing constants, the encrypted
 * Automerge Presence per doc, and the pending-setup retry maps. DocRegistry
 * entries no longer carry presence state — see {@link PresenceEntry} below.
 *
 * The mixin chain is composed in drive-engine.ts:
 *   EngineCore → EngineSettings → EnginePresence → EngineRendezvous → EngineWatch
 * so this module can call the core's `protected` members (`emit`, `respond`,
 * `getOrLoadHandle`, `getOrCreateEntry`, `getKhDoc`, …) directly on `this`.
 */
import type { EngineCore } from './drive-engine';
import type { MainToWorker } from './worker-protocol';
import { errMsg, bytesToBase64 } from './keyhive-ops';
import { createLogger } from './logger';
import { newestPeerPerAgent } from './peer-id';

const log = createLogger('engine');

export type EngineCtor = new (...args: any[]) => EngineCore;

/** One encrypted presence channel, plus the key epoch it was encrypted under. */
export interface PresenceCiphertext {
  enc: Uint8Array;
  /** See {@link presenceEpochOf}. */
  epoch: string;
}

/** Live presence for one doc (replaces the six DocEntry fields the core used to carry). */
export interface PresenceEntry {
  presence: any;
  doc: any;                                  // the keyhive Document presence encrypts against
  desired: Record<string, unknown>;          // current broadcast state (what we want the peers to see)
  send: () => Promise<boolean>;              // snapshot flusher (decrypt + emit update-presence)
  /** What is currently on the wire for each channel (see flushPresenceOutbox). */
  outbox: PresenceOutbox;
  /** A fresh peer has sent us no channels at all: ask it to re-send (see schedulePresenceRetry). */
  needAnnounce: boolean;
  /** Timer for the next retry round, or null when none is pending. */
  retry: any;
  /** Consecutive failed retry rounds — the index into PRESENCE_RETRY_DELAYS_MS. */
  retryAttempt: number;
  liveness: any;                             // setInterval re-checking freshness between events
}

// These are mutable so the set-presence-timing test hook can shrink the
// windows (specs drive a short stale window instead of sleeping past the 12s
// default); production never reassigns them. There is one engine per worker,
// so a module-level override is effectively per-engine.
/** How often each peer's Presence broadcasts a heartbeat when otherwise idle. */
export let PRESENCE_HEARTBEAT_MS = 5000;
/** A peer with no presence activity for this long is hidden from clients
 *  (two missed heartbeats plus network slack). */
export let PRESENCE_STALE_MS = 12_000;
/** How often to re-check freshness between events; worst-case detection
 *  latency is PRESENCE_STALE_MS + this. */
let PRESENCE_LIVENESS_CHECK_MS = 3000;
/** How often to re-attempt presence setup while the doc/keyhive isn't ready. */
const PRESENCE_SETUP_RETRY_MS = 2000;

/** Peers seen within `staleMs` of `now`. Fresh iff now - lastSeen < staleMs. */
export function freshPresencePeerIds(
  lastSeen: ReadonlyMap<string, number>,
  now: number,
  staleMs: number = PRESENCE_STALE_MS,
): Set<string> {
  const fresh = new Set<string>();
  for (const [peerId, seenAt] of lastSeen) {
    if (now - seenAt < staleMs) fresh.add(peerId);
  }
  return fresh;
}

// ── Presence crypto (pure helpers) ───────────────────────────────────────────

const PRESENCE_REF_DOMAIN = 'automerge-drive/presence-content-ref/v1';

/**
 * The keyhive content ref a device encrypts one presence channel under: the
 * same 32 bytes every time, for that device and that channel.
 *
 * keyhive remembers a key for every content ref a peer writes or reads, and
 * keeps them in its archive. A fresh random ref per message — what this used to
 * do — grows the archive by ~65 bytes per presence message, on the sender and
 * on every receiver, without end (presence re-encrypts on every heartbeat and
 * caret move). With one ref per channel there is one remembered key per channel.
 *
 * Reusing a ref means many plaintexts share a key. That is safe with keyhive's
 * cipher, whose nonce is derived from the content: different plaintexts give
 * unrelated ciphertexts (measured — no shared keystream). It is deterministic,
 * though, so equal plaintexts would give equal ciphertexts; {@link
 * sealPresenceValue} salts every plaintext for that reason. Both properties are
 * pinned in tests/presence-crypto.test.ts.
 *
 * Per device as well as per channel, so no two senders ever share a ref.
 */
export async function presenceContentRef(agentId: Uint8Array, channel: string): Promise<Uint8Array> {
  const domain = new TextEncoder().encode(PRESENCE_REF_DOMAIN);
  const name = new TextEncoder().encode(channel);
  const input = new Uint8Array(domain.length + 1 + agentId.length + 1 + name.length);
  input.set(domain, 0);
  input.set(agentId, domain.length + 1);
  input.set(name, domain.length + 1 + agentId.length + 1);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
}

/**
 * A presence value as the bytes to encrypt: `{ s: <random salt>, v: <value> }`.
 * The salt exists only to make every plaintext unique (see presenceContentRef).
 */
export function sealPresenceValue(value: unknown): Uint8Array {
  const salt = crypto.getRandomValues(new Uint8Array(12));
  let s = '';
  for (const b of salt) s += String.fromCharCode(b);
  return new TextEncoder().encode(JSON.stringify({ s: btoa(s), v: value ?? null }));
}

/**
 * The key epoch a `tryEncrypt` result was written under: the hash of the
 * document key its ciphertext names. Two results with the same value were
 * encrypted under the same key; a different value means the peers may need key
 * material they do not have yet.
 *
 * This, not `updateOp()`, is what says "new epoch". `updateOp()` is set only
 * when the encrypt itself minted a rotation op that keyhive returns to the
 * caller — and a member's first encrypt on a document starts a new epoch
 * without it (measured; tests/presence-crypto.test.ts).
 */
export function presenceEpochOf(result: any): string {
  const hash: Uint8Array = result.encryptedContent().pcsKeyHash;
  let s = '';
  for (const b of hash) s += String.fromCharCode(b);
  return btoa(s);
}

/** The value inside decrypted presence bytes (the inverse of sealPresenceValue). */
export function openPresenceValue(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes)).v;
}

/** What a device currently has on the wire for one document's presence. */
export interface PresenceOutbox {
  /** Per channel: the JSON of the value last encrypted, its ciphertext, and its key epoch. */
  sent: Map<string, { json: string; enc: Uint8Array; epoch: string }>;
  /** The key epoch of the most recent encrypt, or null before the first. */
  epoch: string | null;
}

export function newPresenceOutbox(): PresenceOutbox {
  return { sent: new Map(), epoch: null };
}

/**
 * Put `desired` on the wire, encrypting as little as possible.
 *
 * A channel whose value is unchanged is NOT encrypted again: the ciphertext it
 * already has is sent again (or, with `resend: false`, left alone). Only a
 * changed value, or a channel whose last encrypt failed, is encrypted.
 *
 * This is not an optimisation; it is what makes presence converge. Under
 * keyhive >= 0.6 an encrypt made before the peer's latest key operation has
 * arrived starts a NEW key epoch — every time, on both sides, for as long as
 * they keep encrypting concurrently — and a new epoch's ciphertext cannot be
 * read until the operation behind it arrives by keyhive sync, well after the
 * ciphertext itself. Each such ciphertext IS readable once that happens. So
 * re-encrypting an unchanged value to "help" a peer that cannot read us does
 * the opposite: it replaces bytes the peer is about to be able to read with
 * bytes from a newer epoch it cannot, and two peers doing it in step stay one
 * epoch behind each other for good (measured; pinned in
 * tests/presence-crypto.test.ts). The same bytes, sent again, are always safe.
 *
 * When an encrypt does start a new epoch, every other channel is moved to it
 * in the same call (one extra pass), so a channel that never changes does not
 * stay readable under a key the document has rotated away from.
 *
 * The one case where unchanged values ARE encrypted again: keyhive reports a
 * current key (`io.currentEpoch`) that is not the one our bytes are under.
 * That means a peer started a new epoch by itself and we have it — typically a
 * device that restarted, lost the secret for the previous epoch and recovered
 * by rotating; it can no longer read what we have out. Encrypting under a key
 * keyhive already holds does not rotate, so this cannot feed the loop above.
 * (After a merge of concurrent epochs keyhive reports NO current key, and we
 * leave things alone: there, any encrypt would rotate.)
 */
export async function flushPresenceOutbox(
  outbox: PresenceOutbox,
  desired: Record<string, unknown>,
  io: {
    /** Encrypt one channel's value; null if it could not be encrypted. */
    encrypt(channel: string, value: unknown): Promise<PresenceCiphertext | null>;
    broadcast(channel: string, enc: Uint8Array): void;
    /** The key epoch keyhive could encrypt under right now WITHOUT rotating, or null if there is none. */
    currentEpoch?(): Promise<string | null>;
  },
  opts: { resend?: boolean } = {},
): Promise<{ allOk: boolean; newEpoch: boolean }> {
  const resend = opts.resend ?? true;
  let allOk = true;
  let newEpoch = false;
  const current = io.currentEpoch ? await io.currentEpoch() : null;
  // A peer moved the document to an epoch we hold: what we have out is stale.
  const moved = current !== null && outbox.epoch !== null && current !== outbox.epoch;
  // Two passes at most: the second only re-encrypts channels left behind by an
  // epoch change in the first.
  for (let pass = 0; pass < 2; pass++) {
    let changedEpoch = false;
    for (const [channel, value] of Object.entries(desired)) {
      const json = JSON.stringify(value ?? null);
      const have = outbox.sent.get(channel);
      const stale = moved && pass === 0;
      if (have && !stale && have.json === json && have.epoch === outbox.epoch) {
        if (resend && pass === 0) io.broadcast(channel, have.enc);
        continue;
      }
      const out = await io.encrypt(channel, value);
      if (!out) {
        outbox.sent.delete(channel);
        allOk = false;
        continue;
      }
      if (out.epoch !== outbox.epoch) {
        outbox.epoch = out.epoch;
        changedEpoch = true;
        newEpoch = true;
      }
      outbox.sent.set(channel, { json, enc: out.enc, epoch: out.epoch });
      io.broadcast(channel, out.enc);
    }
    if (!changedEpoch) break;
  }
  // Forget channels that are no longer part of the state.
  for (const channel of [...outbox.sent.keys()]) if (!(channel in desired)) outbox.sent.delete(channel);
  return { allOk, newEpoch };
}

/**
 * How long to wait before each retry round while a peer's presence cannot be
 * read (or ours could not be encrypted). Short at first — the usual cause is
 * key material that is a keyhive sync round away — then backing off. The last
 * value repeats.
 */
const PRESENCE_RETRY_DELAYS_MS = [400, 800, 1500, 3000, 5000];

/**
 * The peers to SHOW: fresh ones, collapsed to one peerId per device.
 *
 * A peerId names one engine boot, not a device (see peer-id.ts): a peer that
 * reloads returns under a new peerId while its previous one — which never said
 * goodbye — is still inside the stale window. Keeping only the newest-seen id
 * per agent drops that ghost as soon as the device is heard from again, rather
 * than PRESENCE_STALE_MS later.
 */
export function visiblePresencePeerIds(
  lastSeen: ReadonlyMap<string, number>,
  now: number,
  staleMs: number = PRESENCE_STALE_MS,
): Set<string> {
  return newestPeerPerAgent(freshPresencePeerIds(lastSeen, now, staleMs), lastSeen);
}

/**
 * The narrow surface the CORE (base class) calls up into this module — the
 * "manager calls" behind archive-doc and watchClose. Set in the mixin
 * field-initializer to `this` (one late-bound getter per feature module).
 */
export interface EnginePresenceSurface {
  cancelPending(docId: string): void;
  teardown(docId: string): void;
  isActive(docId: string): boolean;
  /** Stop every running presence + pending retry (full-backup restore). */
  clearAll(): void;
}

export function EnginePresence<C extends EngineCtor>(Base: C):
  new (...args: any[]) => InstanceType<C> & EnginePresenceSurface {
  return class EnginePresenceMixin extends Base {
    // Presence subscriptions still waiting for the doc/keyhive to be ready:
    // docId → retry timer (null while an attempt is in flight). Present iff a
    // subscription wants presence that hasn't started yet.
    protected presencePending = new Map<string, any>();
    // set-presence state that arrived before presence finished starting.
    protected presenceDesiredEarly = new Map<string, Record<string, unknown>>();
    // docId → live presence (see PresenceEntry).
    protected presenceByDoc = new Map<string, PresenceEntry>();

    // The core's late-bound hook into this module (field initializer — see
    // engine-settings.ts for why the mixins avoid constructors).
    protected presenceSurface: EnginePresenceSurface = this as any;

    // ── Presence crypto ────────────────────────────────────────────────────
    private async encryptPresenceValue(doc: any, channel: string, value: unknown): Promise<PresenceCiphertext> {
      const kh = this.khOps!.kh;
      const ref = new this.bridge.ChangeId(await presenceContentRef(kh.id.toBytes(), channel));
      // No predecessor refs: a presence value stands alone, and keyhive requires
      // any predecessor to be content this keyhive has itself written or read.
      const result = await kh.tryEncrypt(doc.docId, ref, [], sealPresenceValue(value));
      // The epoch tells flushPresenceOut whether this ciphertext is under a key
      // the peers may not have yet.
      return { enc: result.encryptedContent().toBytes(), epoch: presenceEpochOf(result) };
    }
    private async decryptPresenceValue(doc: any, enc: Uint8Array): Promise<unknown> {
      const decrypted = await this.khOps!.kh.tryDecrypt(doc.docId, this.bridge.Encrypted.fromBytes(enc));
      return openPresenceValue(decrypted);
    }
    private async encryptPresenceValueOrNull(doc: any, channel: string, value: unknown): Promise<PresenceCiphertext | null> {
      try { return await this.encryptPresenceValue(doc, channel, value); }
      catch (err) {
        // Swallowing this silently hid a wedged CGKA ("SecretKey not found" after
        // a reload lost an in-memory leaf secret) for a long time — keep it loud.
        log.warn('presence encrypt failed:', errMsg(err));
        return null;
      }
    }
    /**
     * Put the entry's desired state on the wire (see flushPresenceOutbox for
     * what is and is not encrypted). `resend: false` sends nothing for channels
     * that are already out — used by the retry, which only has to make up for
     * an encrypt that failed.
     */
    private async flushPresenceOut(entry: PresenceEntry, opts: { resend?: boolean } = {}): Promise<boolean> {
      if (!entry.presence || !entry.doc || !entry.desired) return true;
      const { allOk, newEpoch } = await flushPresenceOutbox(entry.outbox, entry.desired, {
        encrypt: (channel, value) => this.encryptPresenceValueOrNull(entry.doc, channel, value),
        broadcast: (channel, enc) => entry.presence.broadcast(channel, enc),
        currentEpoch: async () => {
          try {
            const hash: Uint8Array | undefined = await this.khOps!.kh.tryPcsKeyHash(entry.doc.docId);
            return hash ? bytesToBase64(hash) : null;
          } catch { return null; }
        },
      }, opts);
      // A new key epoch (including our very first send) means the peers need a
      // key operation before they can read what we just sent — and the
      // cyphertext is ALREADY on the wire, because presence.broadcast goes out
      // immediately while the bridge holds a new op behind a 1s debounce before
      // syncing it. Pushing the sync now makes the key race the cyphertext
      // instead of trailing it by a second.
      if (newEpoch) this.khIntegration?.networkAdapter?.syncKeyhive?.();
      return allOk;
    }

    /**
     * Keep trying until every fresh peer's presence is readable and all of ours
     * is out. A round never re-encrypts what is already on the wire (see
     * flushPresenceOutbox for why that would make things worse); it:
     *
     *  - asks keyhive to sync, since the usual reason a peer cannot be read is
     *    that the operation carrying its key has not arrived yet;
     *  - encrypts any channel of ours whose encrypt failed;
     *  - tries the peers' cyphertext again — the same bytes decrypt once the
     *    key is here;
     *  - if a peer has sent no channels at all, or still cannot be read after
     *    a couple of rounds, announces us. The peer answers by sending its
     *    channels again — re-encrypted only if the document's key has moved to
     *    an epoch it holds, which is the case when we are a device that lost a
     *    secret in a restart and recovered by rotating.
     *
     * The delay is jittered so two peers that started failing at the same
     * moment do not keep acting at the same moment.
     */
    private schedulePresenceRetry(entry: PresenceEntry): void {
      if (entry.retry) return;
      const base = PRESENCE_RETRY_DELAYS_MS[Math.min(entry.retryAttempt, PRESENCE_RETRY_DELAYS_MS.length - 1)];
      const delay = base * (0.75 + Math.random() * 0.5);
      const timer: any = setTimeout(async () => {
        entry.retry = null;
        if (!entry.presence) return;
        entry.retryAttempt++;
        this.khIntegration?.networkAdapter?.syncKeyhive?.();
        const outOk = await this.flushPresenceOut(entry, { resend: false });
        // send() schedules the next round itself when a peer is still unreadable.
        const inOk = entry.send ? await entry.send() : true;
        if (outOk && inOk) { entry.retryAttempt = 0; return; }
        if (entry.needAnnounce || entry.retryAttempt >= 2) (entry.presence as any)?.broadcastLocalState?.();
        this.schedulePresenceRetry(entry);
      }, delay);
      if (typeof timer?.unref === 'function') timer.unref();
      entry.retry = timer;
    }

    /** Drop any pending presence-setup retry (and its buffered early state). */
    cancelPending(docId: string): void {
      const t = this.presencePending.get(docId);
      if (t) clearTimeout(t);
      this.presencePending.delete(docId);
      this.presenceDesiredEarly.delete(docId);
    }

    /** Stop and forget a doc's running presence (timers, listeners, goodbye). */
    teardown(docId: string): void {
      const entry = this.presenceByDoc.get(docId);
      if (!entry?.presence) return;
      if (entry.retry) { clearTimeout(entry.retry); entry.retry = null; }
      if (entry.liveness) { clearInterval(entry.liveness); entry.liveness = null; }
      entry.presence.stop();
      this.presenceByDoc.delete(docId);
    }

    /** Stop every running presence + pending retry (full-backup restore). */
    clearAll(): void {
      for (const docId of [...this.presenceByDoc.keys()]) this.teardown(docId);
      for (const docId of [...this.presencePending.keys()]) this.cancelPending(docId);
    }

    /** Whether a doc currently has running presence (watchClose keeps it open if so). */
    isActive(docId: string): boolean {
      return !!this.presenceByDoc.get(docId)?.presence;
    }

    /**
     * Create + start the Presence for a doc. Returns false when keyhive isn't
     * ready for it yet (caller retries); throws when the doc handle can't be
     * loaded yet; returns true once presence is running.
     */
    private async trySetupPresence(docId: string): Promise<boolean> {
      const handle = await this.getOrLoadHandle(docId);
      this.getOrCreateEntry(docId, handle);
      const existing = this.presenceByDoc.get(docId);
      if (existing?.presence) {
        void existing.send?.(); // give the new subscriber a current snapshot
        return true;
      }
      const doc = await this.getKhDoc(docId);
      if (!doc) return false;

      const presence = new this.PresenceClass({ handle });
      // Library pruning is disabled (peerTtlMs = MAX_SAFE_INTEGER): its heartbeat
      // handler (markSeen) bumps lastUpdateAt while prune() filters on
      // lastActiveAt, so it drops idle-but-heartbeating peers. Liveness is
      // tracked here instead, via lastSeen below.
      presence.start({
        initialState: {},
        heartbeatMs: PRESENCE_HEARTBEAT_MS,
        peerTtlMs: Number.MAX_SAFE_INTEGER,
      });
      const userGroupId = await this.khOps?.getUserGroupId();
      const desired: Record<string, unknown> = {
        viewing: true,
        focusedField: null,
        ...(userGroupId ? { userGroupId } : {}),
        // State the main thread set while setup was still retrying.
        ...(this.presenceDesiredEarly.get(docId) ?? {}),
      };
      this.presenceDesiredEarly.delete(docId);

      const lastSeen = new Map<string, number>();
      let lastEmittedFresh = new Set<string>();
      const sendPresence = async (): Promise<boolean> => {
        const raw = presence.getPeerStates().value;
        const fresh = visiblePresencePeerIds(lastSeen, Date.now());
        const peers: Record<string, any> = {};
        let allOk = true;
        let needAnnounce = false;
        for (const [peerId, st] of Object.entries<any>(raw)) {
          if (!fresh.has(peerId)) continue; // stale or superseded — hide and skip decrypt work
          const value: Record<string, unknown> = {};
          // Nothing received from this peer yet (only its heartbeat): no key
          // would help — it has to send its channels again.
          if (Object.keys(st?.value ?? {}).length === 0) needAnnounce = true;
          for (const [ch, enc] of Object.entries<any>(st?.value ?? {})) {
            try { value[ch] = await this.decryptPresenceValue(doc, enc as Uint8Array); }
            catch (err) {
              allOk = false;
              log.warn(`presence decrypt failed (peer ${peerId}, channel ${ch}):`, errMsg(err));
            }
          }
          // A fresh peer with no readable state — nothing received yet, or
          // nothing we could decrypt — needs the retry loop's re-announce.
          if (Object.keys(value).length === 0) allOk = false;
          // A heartbeat-first entry has no peerId of its own; the map key fills it in.
          peers[peerId] = { peerId, ...st, value };
        }
        lastEmittedFresh = fresh;
        entry.needAnnounce = needAnnounce;
        this.emit({ type: 'update-presence', docId, peers });
        if (!allOk) this.schedulePresenceRetry(entry);
        return allOk;
      };
      const entry: PresenceEntry = { presence, doc, desired, send: sendPresence, outbox: newPresenceOutbox(), needAnnounce: false, retry: null, retryAttempt: 0, liveness: null };
      this.presenceByDoc.set(docId, entry);
      presence.on('update', (e: any) => { lastSeen.set(e.peerId, Date.now()); void sendPresence(); });
      presence.on('snapshot', (e: any) => {
        lastSeen.set(e.peerId, Date.now());
        // A snapshot is an announce: the sender either just started (its
        // Presence.start broadcast, possibly after a reload) or has none of our
        // channels and is asking for them (see schedulePresenceRetry). Respond
        // by sending our channels again — the SAME cyphertext, not a fresh
        // encrypt (see flushPresenceOutbox). They go out as updates, never
        // snapshots, so two peers can't ping-pong announces.
        void this.flushPresenceOut(entry);
        void sendPresence();
      });
      presence.on('goodbye', (e: any) => { lastSeen.delete(e.peerId); void sendPresence(); });
      presence.on('heartbeat', (e: any) => {
        const wasFresh = lastEmittedFresh.has(e.peerId);
        lastSeen.set(e.peerId, Date.now());
        // Steady-state heartbeats only bump lastSeen; re-emit just for a peer
        // that was hidden (new, or returning after going stale).
        if (!wasFresh) void sendPresence();
      });
      const setsEqual = (a: Set<string>, b: Set<string>) =>
        a.size === b.size && [...a].every(x => b.has(x));
      entry.liveness = setInterval(() => {
        if (!setsEqual(visiblePresencePeerIds(lastSeen, Date.now()), lastEmittedFresh)) {
          void sendPresence();
        }
      }, PRESENCE_LIVENESS_CHECK_MS);
      if (typeof entry.liveness?.unref === 'function') entry.liveness.unref();
      if (!(await this.flushPresenceOut(entry))) this.schedulePresenceRetry(entry);
      return true;
    }

    /** Handle this module's message types; passes everything else down the chain. */
    async handleMessage(msg: MainToWorker): Promise<void> {
      if (msg.type === 'set-presence-timing') {
        // Test hook: override presence timing so specs can drive a short stale
        // window instead of sleeping past the 12s default. Takes effect on the
        // next presence setup, so callers must set it before subscribing.
        await this.respond(msg.id, async () => {
          if (typeof msg.staleMs === 'number') PRESENCE_STALE_MS = msg.staleMs;
          if (typeof msg.heartbeatMs === 'number') PRESENCE_HEARTBEAT_MS = msg.heartbeatMs;
          if (typeof msg.livenessCheckMs === 'number') PRESENCE_LIVENESS_CHECK_MS = msg.livenessCheckMs;
        });
        return;
      }

      if (msg.type === 'subscribe-presence') {
        // On a cold worker the doc handle / keyhive doc may not be ready yet
        // (repo.find can throw before the first sync), so keep retrying until
        // setup succeeds or the doc is unsubscribed — a one-shot attempt left
        // presence permanently dead for pages loaded directly on an editor URL.
        if (this.presencePending.has(msg.docId)) return; // already being established
        this.presencePending.set(msg.docId, null); // null = attempt in flight
        const attempt = async () => {
          let ok = false;
          try { ok = await this.trySetupPresence(msg.docId); }
          catch (err: any) { log.warn('presence-subscribe not ready, retrying:', errMsg(err)); }
          if (!this.presencePending.has(msg.docId)) {
            // Unsubscribed while this attempt ran — undo a setup that won the race.
            if (ok) this.teardown(msg.docId);
            return;
          }
          if (ok) { this.cancelPending(msg.docId); return; }
          const t: any = setTimeout(() => { void attempt(); }, PRESENCE_SETUP_RETRY_MS);
          if (typeof t?.unref === 'function') t.unref();
          this.presencePending.set(msg.docId, t);
        };
        void attempt();
        return;
      }

      if (msg.type === 'unsubscribe-presence') {
        this.cancelPending(msg.docId);
        this.teardown(msg.docId);
        return;
      }

      if (msg.type === 'set-presence') {
        const entry = this.presenceByDoc.get(msg.docId);
        if (entry?.presence) {
          entry.desired = { ...(entry.desired ?? {}), ...msg.state };
          if (!(await this.flushPresenceOut(entry))) this.schedulePresenceRetry(entry);
        } else if (this.presencePending.has(msg.docId)) {
          // Presence is still starting — buffer the state so it broadcasts once
          // setup succeeds instead of being silently dropped.
          this.presenceDesiredEarly.set(msg.docId, {
            ...(this.presenceDesiredEarly.get(msg.docId) ?? {}),
            ...msg.state,
          });
        }
        return;
      }

      await super.handleMessage(msg);
    }
  } as any;
}
