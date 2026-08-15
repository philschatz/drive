/**
 * Rendezvous + relay-discovery subsystem for DriveEngine (class-expression mixin
 * over the core).
 *
 * Owns the live rendezvous sessions (QR friend/device exchange), the encrypted
 * `kh-rdv-*` share/receive/link handlers, and the RELAY_WATCH discovery
 * declaration. Extends the settings mixin, so friends/device-name stores and
 * the DriveSettings doc are reachable directly on `this`.
 *
 * The mixin chain is composed in drive-engine.ts:
 *   EngineCore → EngineSettings → EnginePresence → EngineRendezvous → EngineWatch
 * and the core reaches in through the late-bound {@link EngineRendezvousSurface}
 * (assigned in a field initializer to `this`) for its init() wiring.
 */
import { generateRendezvous, encryptString, decryptString } from './rendezvous-crypto';
import { formatBytes } from './format-bytes';
import {
  RDV_SUB, RDV_UNSUB, RDV_MSG, RDV_PEER,
  type RendezvousStatus,
} from './rendezvous-protocol';
import { buildRelayWatchFrame } from './relay-identity';
import { errMsg } from './keyhive-ops';
import type { EngineCore } from './drive-engine';
import type { EngineSettingsSurface } from './engine-settings';
import type { MainToWorker } from './worker-protocol';
import { createLogger } from './logger';

const log = createLogger('engine');

/** Base this mixin extends: the core plus the settings mixin's surface, so the
 *  rendezvous code can call the settings members (`driveSettingsDoc`, the name
 *  stores, …) directly on `this`. */
export type EngineRendezvousCtor = new (...args: any[]) =>
  EngineCore & EngineSettingsSurface;

/**
 * One live rendezvous. `onPeer` fires when another peer joins the topic; `onData`
 * fires with the decrypted payload of an inbound message. A one-way share sets only
 * `onPeer`; a receiver sets only `onData`; a device link sets both.
 */
export interface RdvSession {
  key: string;
  onPeer?: () => void;
  onData?: (plaintext: string) => void;
}

const RDV_RECEIVE_TIMEOUT_MS = 120_000;

/**
 * Upper bound on an inbound encrypted rendezvous payload. Anyone who learns a
 * topic id (or a hostile relay) can push bytes at it, so cap the size BEFORE
 * any decrypt/parse work. A legitimate payload is a contact bundle — a few KB,
 * and flat in the sender's document count (see `KeyhiveOps.contactBundleEvents`)
 * — so 256 KiB is generous headroom rather than a working limit.
 */
export const RDV_MAX_DATA_BYTES = 256 * 1024;

/** AES-GCM framing added by `encryptString`: a 12-byte IV plus the 16-byte tag. */
const RDV_FRAME_OVERHEAD_BYTES = 28;

/**
 * The surface the CORE (base class) calls up into this module for its init()
 * wiring plus this mixin's external API (rendezvous-link join). Set in a
 * field initializer to `this` — one late-bound getter per feature module. It
 * also types the composed instance, so every public member is listed here.
 */
export interface EngineRendezvousSurface {
  lastRelayWatch: string | null;
  handleRendezvousFrame(msg: any): void;
  scheduleRelayWatchRefresh(): void;
  refreshRelayWatch(): Promise<void>;
  rendezvousLinkJoin(
    rendezvousId: string, key: string, deviceName?: string,
  ): Promise<{ ok: true }>;
}

export function EngineRendezvous<C extends EngineRendezvousCtor>(Base: C):
  new (...args: any[]) => InstanceType<C> & EngineRendezvousSurface {
  return class EngineRendezvousMixin extends Base {
    // Rendezvous.
    protected rdvSessions = new Map<string, RdvSession>();
    /** Serialized last-sent RELAY_WATCH frame (diff guard) and its debounce timer. */
    lastRelayWatch: string | null = null;
    protected relayWatchTimer: ReturnType<typeof setTimeout> | null = null;

    // The core's late-bound hook into this module (field initializer — see
    // engine-settings.ts for why the mixins avoid constructors).
    protected rendezvousSurface: EngineRendezvousSurface = this as any;

    // ── Rendezvous ─────────────────────────────────────────────────────────────
    // ── Relay discovery declaration (RELAY_WATCH) ───────────────────────────────

    /**
     * Recompute and (re)send the relay discovery declaration: this device's own
     * user-group id plus every group it knows (friends roster + doc co-member
     * groups). The relay introduces only mutually-declared peers — see
     * WebSocketRelay's doc comment for the rules, the limits of self-asserted
     * group ids, and the planned HMAC-token upgrade — so keeping this fresh is
     * what makes friends discoverable at all. Debounced + diffed, so it is cheap
     * to schedule from every roster-affecting site.
     */
    scheduleRelayWatchRefresh(): void {
      if (this.relayWatchTimer !== null) return;
      this.relayWatchTimer = setTimeout(() => {
        this.relayWatchTimer = null;
        void this.refreshRelayWatch();
      }, 500);
      // Node only (browser timers are numbers): a pending debounce must not hold
      // a short-lived CLI command open.
      (this.relayWatchTimer as any).unref?.();
    }

    async refreshRelayWatch(): Promise<void> {
      if (!this.khOps) return;
      try {
        const group = await this.khOps.getUserGroupId();
        if (!group) return; // no user group yet — nothing to declare, nobody to pair with
        const friendGroupIds = Object.keys(this.driveSettingsDoc()?.friends ?? {});
        const known = await this.khOps.getKnownFriends(undefined, friendGroupIds);
        const frame = buildRelayWatchFrame(
          group,
          known.filter((m) => m.type === 'group' && !m.isMe).map((m) => m.agentId),
        );
        const serialized = JSON.stringify(frame);
        if (serialized === this.lastRelayWatch) return;
        this.lastRelayWatch = serialized;
        this.host.network.sendOverlayFrame(frame);
      } catch (err) {
        log.warn('relay watch refresh failed:', errMsg(err));
      }
    }

    private rdvSend(frame: { type: string; rendezvousId: string; data?: Uint8Array }): void {
      this.host.network.sendOverlayFrame(frame);
    }
    private rdvEvent(rendezvousId: string, status: RendezvousStatus, message?: string, extra?: { friendGroupId?: string; friendHasName?: boolean }): void {
      this.emit({ type: 'kh-rdv-event', rendezvousId, status, ...(message !== undefined ? { message } : {}), ...(extra ?? {}) });
    }
    /**
     * Refuse a payload the peer would be forced to throw away.
     * {@link handleRendezvousFrame} drops anything over {@link RDV_MAX_DATA_BYTES}
     * before decrypting, so sending one anyway leaves the receiver waiting out
     * RDV_RECEIVE_TIMEOUT_MS and then blaming the other device's QR — a diagnosis
     * no amount of retrying can fix. Fail on this side, where we know the reason.
     */
    private assertRdvPayloadFits(byteLength: number): void {
      if (byteLength <= RDV_MAX_DATA_BYTES) return;
      throw new Error(
        `This device's contact card is too large to exchange (${formatBytes(byteLength)}, limit ${formatBytes(RDV_MAX_DATA_BYTES)}).`,
      );
    }
    private async rdvSendPayload(rendezvousId: string, key: string, plaintext: string): Promise<void> {
      const framed = await encryptString(key, plaintext);
      this.assertRdvPayloadFits(framed.length);
      this.rdvEvent(rendezvousId, 'sending', formatBytes(framed.length));
      this.rdvSend({ type: RDV_MSG, rendezvousId, data: framed });
    }
    /**
     * Parse a rendezvous payload: an envelope `{card, displayName?, userGroupId?,
     * deviceName?, driveSettingsDocId?}` — or a bare card string (the friend-share
     * reply is always an envelope, but older/mirror flows tolerate the raw card).
     */
    private parseRdvPayload(pt: string): { card: string; displayName?: string; userGroupId?: string; deviceName?: string; driveSettingsDocId?: string } {
      try {
        const parsed = JSON.parse(pt);
        if (parsed && typeof parsed === 'object' && typeof parsed.card === 'string') return parsed as any;
      } catch { /* bare card string */ }
      return { card: pt };
    }
    /** Handle an inbound rendezvous frame (host routes rdv frames here). */
    handleRendezvousFrame(msg: any): void {
      const rid: string | undefined = msg.rendezvousId;
      if (!rid) return;
      const session = this.rdvSessions.get(rid);
      if (!session) return;
      if (msg.type === RDV_PEER) {
        session.onPeer?.();
      } else if (msg.type === RDV_MSG && session.onData) {
        const data: Uint8Array = msg.data instanceof Uint8Array ? msg.data : new Uint8Array(msg.data);
        if (data.byteLength > RDV_MAX_DATA_BYTES) {
          log.warn(`dropping oversized rendezvous payload (${data.byteLength} bytes, max ${RDV_MAX_DATA_BYTES})`);
          // Say what happened rather than leaving the user to wait out
          // RDV_RECEIVE_TIMEOUT_MS and be told to check the other device's QR. The
          // session deliberately stays open: anyone who learns a topic id can push
          // bytes at it, so tearing down here would hand them a way to cancel a
          // legitimate exchange. The frame is still dropped before any decrypt work.
          this.rdvEvent(rid, 'error', `The other device sent ${formatBytes(data.byteLength)}, over the ${formatBytes(RDV_MAX_DATA_BYTES)} limit.`);
          return;
        }
        decryptString(session.key, data)
          .then(pt => session.onData!(pt))
          .catch(err => log.error('failed to decrypt inbound rendezvous payload:', errMsg(err)));
      }
    }

    /** Device-link joiner (the new device). Adopts the original device's user-group. */
    async rendezvousLinkJoin(rendezvousId: string, key: string, deviceName?: string): Promise<{ ok: true }> {
      if (!this.khOps) throw new Error('Keyhive not available');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.rdvSessions.delete(rendezvousId);
          reject(new Error('Timed out waiting for your other device. Make sure its QR/link is open, then try again.'));
        }, RDV_RECEIVE_TIMEOUT_MS);
        this.rdvSessions.set(rendezvousId, {
          key,
          onPeer: () => this.rdvEvent(rendezvousId, 'peer-joined'),
          onData: (pt) => {
            (async () => {
              try {
                this.rdvEvent(rendezvousId, 'receiving');
                const { card: peerCard, userGroupId: peerGroupId, deviceName: peerDeviceName, driveSettingsDocId: peerSettingsDocId } =
                  this.parseRdvPayload(pt);
                const result = await this.khOps!.receiveContactCard(peerCard);
                if (result.isOwnCard) throw new Error("This is your own device's link. Open it on a different device.");
                await this.khOps!.linkDevice(result.agentId, peerGroupId ?? null);
                const myUserGroupId = await this.khOps!.ensureUserGroup({ create: true });
                if (peerSettingsDocId) {
                  // The host opted to sync: adopt its DriveSettings doc pointer (trusted
                  // channel) — this makes us SHARED (one-way). The doc itself loads once
                  // its ops sync in; the host records both device names into it, so we do
                  // NOT write to it here (no writing to an unsynced doc, no duplicate).
                  await this.adoptDriveSettingsDoc(peerSettingsDocId);
                } else if (peerDeviceName) {
                  // The host stayed Local (no shared doc). Record its device name in our
                  // own (local) settings so device names still exchange across the link.
                  await this.putDeviceName(result.agentId, peerDeviceName);
                }
                const myCard = await this.khOps!.getContactCard();
                await this.rdvSendPayload(rendezvousId, key, JSON.stringify({
                  card: myCard, userGroupId: myUserGroupId, deviceName,
                  driveSettingsDocId: this.driveSettingsDocId ?? peerSettingsDocId ?? undefined,
                }));
                clearTimeout(timer);
                this.rdvSessions.delete(rendezvousId);
                this.rdvSend({ type: RDV_UNSUB, rendezvousId });
                this.rdvEvent(rendezvousId, 'linked');
                resolve();
              } catch (err) {
                clearTimeout(timer);
                this.rdvSessions.delete(rendezvousId);
                this.rdvSend({ type: RDV_UNSUB, rendezvousId });
                this.rdvEvent(rendezvousId, 'error', errMsg(err));
                reject(err);
              }
            })();
          },
        });
        this.rdvSend({ type: RDV_SUB, rendezvousId });
        this.rdvEvent(rendezvousId, 'waiting');
      });
      void this.reconcileHomeDocsAfterLink();
      return { ok: true };
    }

    /** Handle this module's message types; passes everything else down the chain. */
    async handleMessage(msg: MainToWorker): Promise<void> {
      // Sharer: stage our (large) contact bundle for a rendezvous and return the id+key.
      if (msg.type === 'kh-rdv-create-share') {
        await this.respond(msg.id, async () => {
          if (!this.khOps) throw new Error('Keyhive not available');
          const myUserGroupId = await this.khOps.ensureUserGroup({ create: true });
          // Approximate size of what we'll send once the peer joins (plaintext bytes;
          // the on-wire framed size adds only ~28 bytes of IV+GCM tag). Surfaced to the
          // sender's QR page so they can see how much is being transferred up front.
          // Estimated rather than measured because building the real payload would
          // MINT a prekey — see the deferred getContactCard() in onPeer below. The
          // envelope is the real one, so only the card body is approximate.
          const payloadBytes = new TextEncoder().encode(JSON.stringify({
            card: await this.khOps.previewContactCard(),
            displayName: msg.displayName, userGroupId: myUserGroupId ?? undefined,
          })).length;
          // Check before minting a rendezvous, so we never show a QR that cannot work.
          this.assertRdvPayloadFits(payloadBytes + RDV_FRAME_OVERHEAD_BYTES);
          const { rendezvousId, key } = generateRendezvous();
          // Bidirectional: after sending our bundle we STAY subscribed to ingest the
          // receiver's reply (their card + display name) so both peers end up knowing
          // each other from a single scan. The receiver's own UI names us; we have no
          // UI here, so the worker records their name from the reply payload.
          this.rdvSessions.set(rendezvousId, {
            key,
            onPeer: () => {
              this.rdvEvent(rendezvousId, 'peer-joined');
              // Mint the card HERE, not at stage time: every getContactCard() rotates
              // a prekey out of our advertised pool, and that key is meant for one
              // contact. Staging a QR nobody scans must not consume one — otherwise
              // just opening the invite screen grows our prekey history forever.
              (async () => {
                const myCard = await this.khOps!.getContactCard();
                await this.rdvSendPayload(rendezvousId, key, JSON.stringify({
                  card: myCard, displayName: msg.displayName, userGroupId: myUserGroupId ?? undefined,
                }));
              })().catch((err) => this.rdvEvent(rendezvousId, 'error', errMsg(err)));
            },
            onData: (pt) => {
              void (async () => {
                try {
                  this.rdvEvent(rendezvousId, 'receiving');
                  const { card: cardJson, displayName, userGroupId: replyGroupId } = this.parseRdvPayload(pt);
                  const result = await this.khOps!.receiveContactCard(cardJson);
                  const resolvedGroupId = replyGroupId ?? result.groupId ?? null;
                  const added = !result.isOwnCard && !!resolvedGroupId;
                  if (added) {
                    await this.addKnownFriendGroup(resolvedGroupId!);
                    await this.putFriendName(resolvedGroupId!, displayName);
                  }
                  this.rdvSessions.delete(rendezvousId);
                  this.rdvSend({ type: RDV_UNSUB, rendezvousId });
                  // Surface who we added back (and whether they sent a name) so the
                  // sharer's UI can offer a name input when they didn't — the sharer
                  // otherwise has no chance to label a nameless friend.
                  this.rdvEvent(rendezvousId, 'received', undefined, added
                    ? { friendGroupId: resolvedGroupId!, friendHasName: !!displayName?.trim() }
                    : undefined);
                } catch (err: any) {
                  this.rdvSessions.delete(rendezvousId);
                  this.rdvSend({ type: RDV_UNSUB, rendezvousId });
                  this.rdvEvent(rendezvousId, 'error', errMsg(err));
                }
              })();
            },
          });
          this.rdvSend({ type: RDV_SUB, rendezvousId });
          this.rdvEvent(rendezvousId, 'waiting');
          return { rendezvousId, key, payloadBytes };
        });
        return;
      }

      if (msg.type === 'kh-rdv-receive') {
        const { rendezvousId, key } = msg;
        try {
          if (!this.khOps) throw new Error('Keyhive not available');
          const plaintext = await new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => {
              this.rdvSessions.delete(rendezvousId);
              reject(new Error('Timed out waiting for your friend. Make sure they have the QR/link open, then try again.'));
            }, RDV_RECEIVE_TIMEOUT_MS);
            this.rdvSessions.set(rendezvousId, {
              key,
              onPeer: () => this.rdvEvent(rendezvousId, 'peer-joined'),
              onData: (pt) => {
                clearTimeout(timer);
                this.rdvSessions.delete(rendezvousId);
                this.rdvEvent(rendezvousId, 'receiving');
                resolve(pt);
              },
            });
            this.rdvSend({ type: RDV_SUB, rendezvousId });
            this.rdvEvent(rendezvousId, 'waiting');
          });

          const { card: cardJson, displayName, userGroupId } = this.parseRdvPayload(plaintext);

          const result = await this.khOps.receiveContactCard(cardJson);
          const resolvedGroupId = userGroupId ?? result.groupId ?? null;
          const alreadyKnown = !result.isOwnCard && !!resolvedGroupId
            ? await this.addKnownFriendGroup(resolvedGroupId)
            : false;
          if (!result.isOwnCard) {
            const myUserGroupId = await this.khOps.ensureUserGroup({ create: true });
            const myCard = await this.khOps.getContactCard();
            await this.rdvSendPayload(rendezvousId, key, JSON.stringify({ card: myCard, displayName: msg.displayName, userGroupId: myUserGroupId ?? undefined }));
          }
          this.rdvSend({ type: RDV_UNSUB, rendezvousId });
          this.rdvEvent(rendezvousId, 'received');
          this.emit({ type: 'result', id: msg.id, result: { ...result, userGroupId: resolvedGroupId, displayName, alreadyKnown } });
        } catch (err: any) {
          this.rdvSessions.delete(rendezvousId);
          this.rdvSend({ type: RDV_UNSUB, rendezvousId });
          this.rdvEvent(rendezvousId, 'error', errMsg(err));
          this.emit({ type: 'result', id: msg.id, error: errMsg(err) });
        }
        return;
      }

      if (msg.type === 'kh-rdv-link-create') {
        await this.respond(msg.id, async () => {
          if (!this.khOps) throw new Error('Keyhive not available');
          const myUserGroupId = await this.khOps.ensureUserGroup({ create: true });
          // Ensure our DriveSettings doc exists so we can hand its id to the joining
          // device (the trusted channel that propagates the pointer — never a scan).
          await this.ensureDriveSettingsDoc({ create: true });
          // The envelope our card will travel in. Built here for the size estimate
          // with a non-minting card, and again in onPeer with the real one.
          const envelope = (card: string) => JSON.stringify({
            card, userGroupId: myUserGroupId, deviceName: msg.deviceName,
            driveSettingsDocId: this.driveSettingsDocId ?? undefined,
          });
          // See kh-rdv-create-share: approximate payload size for the sender's QR page.
          const payloadBytes = new TextEncoder().encode(envelope(await this.khOps.previewContactCard())).length;
          this.assertRdvPayloadFits(payloadBytes + RDV_FRAME_OVERHEAD_BYTES);
          const { rendezvousId, key } = generateRendezvous();
          this.rdvSessions.set(rendezvousId, {
            key,
            onPeer: () => {
              this.rdvEvent(rendezvousId, 'peer-joined');
              // Mint only for a real exchange — see kh-rdv-create-share's onPeer.
              (async () => {
                await this.rdvSendPayload(rendezvousId, key, envelope(await this.khOps!.getContactCard()));
              })().catch(err => this.rdvEvent(rendezvousId, 'error', errMsg(err)));
            },
            onData: (pt) => {
              (async () => {
                try {
                  this.rdvEvent(rendezvousId, 'receiving');
                  const { card: peerCard, userGroupId: peerGroupId, deviceName: peerDeviceName } = this.parseRdvPayload(pt);
                  const result = await this.khOps!.receiveContactCard(peerCard);
                  await this.khOps!.linkDevice(result.agentId, peerGroupId ?? null);
                  // We (the host) hold the shared settings doc locally, so record BOTH
                  // device names here: the joiner's, and our own (its default name),
                  // so both sync down to the joiner once it adopts the doc.
                  await this.putDeviceName(result.agentId, peerDeviceName);
                  if (msg.deviceName) {
                    const myAgentId = (await this.khOps!.getIdentity()).agentId;
                    await this.putDeviceName(myAgentId, msg.deviceName);
                  }
                  this.rdvSessions.delete(rendezvousId);
                  this.rdvSend({ type: RDV_UNSUB, rendezvousId });
                  this.rdvEvent(rendezvousId, 'linked');
                } catch (err: any) {
                  this.rdvEvent(rendezvousId, 'error', errMsg(err));
                }
              })();
            },
          });
          this.rdvSend({ type: RDV_SUB, rendezvousId });
          this.rdvEvent(rendezvousId, 'waiting');
          return { rendezvousId, key, payloadBytes };
        });
        return;
      }

      if (msg.type === 'kh-rdv-link-join') {
        await this.respond(msg.id, () => this.rendezvousLinkJoin(msg.rendezvousId, msg.key, msg.deviceName));
        return;
      }

      if (msg.type === 'kh-rdv-cancel') {
        this.rdvSessions.delete(msg.rendezvousId);
        this.rdvSend({ type: RDV_UNSUB, rendezvousId: msg.rendezvousId });
        return;
      }

      await super.handleMessage(msg);
    }
  } as any;
}
