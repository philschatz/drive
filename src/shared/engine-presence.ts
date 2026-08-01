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
import { errMsg } from './keyhive-ops';

export type EngineCtor = new (...args: any[]) => EngineCore;

/** One encrypted presence channel, plus whether encrypting it rotated the CGKA. */
export interface PresenceCiphertext {
  enc: Uint8Array;
  rotated: boolean;
}

/** Live presence for one doc (replaces the six DocEntry fields the core used to carry). */
export interface PresenceEntry {
  presence: any;
  doc: any;                                  // the keyhive Document presence encrypts against
  desired: Record<string, unknown>;          // current broadcast state (what we want the peers to see)
  send: () => Promise<boolean>;              // snapshot flusher (decrypt + emit update-presence)
  retry: any;                                // setInterval while out/in-bound sync isn't quiescent
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
    private async encryptPresenceValue(doc: any, value: unknown): Promise<PresenceCiphertext> {
      const bytes = new TextEncoder().encode(JSON.stringify(value ?? null));
      const ref = new this.bridge.ChangeId(crypto.getRandomValues(new Uint8Array(32)));
      const result = await this.khOps!.kh.tryEncrypt(doc, ref, [], bytes);
      // `update_op()` is defined only when this encrypt rotated the CGKA epoch —
      // i.e. only then did it mint key material the peer does not have yet. See
      // flushPresenceOut for why the caller has to know.
      return { enc: result.encrypted_content().toBytes(), rotated: !!result.update_op() };
    }
    private async decryptPresenceValue(doc: any, enc: Uint8Array): Promise<unknown> {
      const decrypted = await this.khOps!.kh.tryDecrypt(doc, this.bridge.Encrypted.fromBytes(enc));
      return JSON.parse(new TextDecoder().decode(decrypted));
    }
    private async encryptPresenceValueOrNull(doc: any, value: unknown): Promise<PresenceCiphertext | null> {
      try { return await this.encryptPresenceValue(doc, value); }
      catch (err) {
        // Swallowing this silently hid a wedged CGKA ("SecretKey not found" after
        // a reload lost an in-memory leaf secret) for a long time — keep it loud.
        console.warn('[engine] presence encrypt failed:', errMsg(err));
        return null;
      }
    }
    private async flushPresenceOut(entry: PresenceEntry): Promise<boolean> {
      if (!entry.presence || !entry.doc || !entry.desired) return true;
      let allOk = true;
      let rotated = false;
      for (const [k, v] of Object.entries(entry.desired)) {
        const out = await this.encryptPresenceValueOrNull(entry.doc, v);
        if (out) {
          entry.presence.broadcast(k, out.enc);
          if (out.rotated) rotated = true;
        } else allOk = false;
      }
      // A rotation minted key material the peer needs in order to read what we just
      // sent — and the cyphertext is ALREADY on the wire, because presence.broadcast
      // goes out immediately while keyhive holds the new op behind a 1s debounce
      // before syncing it (the `syncTimeout` in the library's keyhive.ts). So the
      // peer reliably receives bytes it cannot decrypt for about a second and logs
      // "Key not found". That alone would heal, but every retry round re-encrypts,
      // so the replacement cyphertext arrives just as early as the last one and the
      // peer can flap indefinitely — one epoch behind, forever. Pushing the material
      // here makes it race the cyphertext instead of trailing it.
      if (rotated) this.khIntegration?.networkAdapter?.syncKeyhive?.();
      return allOk;
    }
    private schedulePresenceRetry(entry: PresenceEntry): void {
      if (entry.retry) return;
      entry.retry = setInterval(async () => {
        if (!entry.presence) { clearInterval(entry.retry); entry.retry = null; return; }
        const outOk = await this.flushPresenceOut(entry);
        const inOk = entry.send ? await entry.send() : true;
        if (outOk && inOk) {
          clearInterval(entry.retry);
          entry.retry = null;
          return;
        }
        // Still failing to decrypt a peer (typical after a reload: the rehydrated
        // keyhive lacks the epoch secrets for the peer's cyphertext). Two levers,
        // both needed: force a keyhive sync round so the missing key material can
        // arrive, and re-announce ourselves — peers respond to a snapshot by
        // re-flushing freshly-encrypted channels (see the 'snapshot' handler) —
        // so each retry round has new material to try until decryption succeeds.
        this.khIntegration?.networkAdapter?.syncKeyhive?.();
        (entry.presence as any)?.broadcastLocalState?.();
      }, 5000);
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
      if (entry.retry) { clearInterval(entry.retry); entry.retry = null; }
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
        const fresh = freshPresencePeerIds(lastSeen, Date.now());
        const peers: Record<string, any> = {};
        let allOk = true;
        for (const [peerId, st] of Object.entries<any>(raw)) {
          if (!fresh.has(peerId)) continue; // stale — hide and skip decrypt work
          const value: Record<string, unknown> = {};
          for (const [ch, enc] of Object.entries<any>(st?.value ?? {})) {
            try { value[ch] = await this.decryptPresenceValue(doc, enc as Uint8Array); }
            catch (err) {
              allOk = false;
              console.warn(`[engine] presence decrypt failed (peer ${peerId}, channel ${ch}):`, errMsg(err));
            }
          }
          // A fresh peer with no readable state — nothing received yet, or
          // nothing we could decrypt — needs the retry loop's re-announce.
          if (Object.keys(value).length === 0) allOk = false;
          // A heartbeat-first entry has no peerId of its own; the map key fills it in.
          peers[peerId] = { peerId, ...st, value };
        }
        lastEmittedFresh = fresh;
        this.emit({ type: 'update-presence', docId, peers });
        if (!allOk) this.schedulePresenceRetry(entry);
        return allOk;
      };
      const entry: PresenceEntry = { presence, doc, desired, send: sendPresence, retry: null, liveness: null };
      this.presenceByDoc.set(docId, entry);
      presence.on('update', (e: any) => { lastSeen.set(e.peerId, Date.now()); void sendPresence(); });
      presence.on('snapshot', (e: any) => {
        lastSeen.set(e.peerId, Date.now());
        // A snapshot is an announce: the sender either just started (its
        // Presence.start broadcast, possibly after a tab reload) or is stuck
        // unable to decrypt us and is asking for fresh material (see
        // schedulePresenceRetry). Respond by re-encrypting and re-sending our
        // channels: a freshly-started peer needs them because the library only
        // re-announces to peerIds it has forgotten (and with pruning disabled it
        // never forgets), and a stuck peer needs fresh cyphertext because each
        // encrypt creates new keyhive ops whose sync delivers the key material
        // it is missing. Flushes go out as updates, never snapshots, so two
        // peers can't ping-pong announces.
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
        if (!setsEqual(freshPresencePeerIds(lastSeen, Date.now()), lastEmittedFresh)) {
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
          catch (err: any) { console.warn('[engine] presence-subscribe not ready, retrying:', errMsg(err)); }
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
