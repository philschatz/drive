/**
 * Subduction links: one connection per peer device, inside the secure channel,
 * for document sync.
 *
 * Documents sync through the Repo's subduction instance, which stores and
 * exchanges commits already encrypted under the document's keyhive key
 * (subduction-interceptor.ts). Subduction needs a connection to each peer; this
 * module gives it one, as a `Transport` it writes subduction frames to and
 * reads them from. The frames travel as `subduction-connection` messages on
 * the secure channel (secure-channel.ts), which is what makes a link safe to
 * build so simply: a peer the channel announces has already proved its device
 * key, and every frame arrives sealed, from that device, in the order it was
 * sent. Subduction itself signs only its handshake and each commit, and its
 * protocol — document ids, commit ids — is otherwise in the clear; inside the
 * channel none of it is visible to the relay.
 *
 * automerge-repo can open these connections itself (`subductionAdapters`), but
 * that path fits a client talking to a server, not two peers: the handshake
 * role is fixed per adapter, so two peers would both initiate, and its
 * transport never tells subduction a peer has left. So:
 *
 * - **Who initiates.** The peer with the lower peerId opens the link and calls
 *   `connectTransport`; the other answers its opening frame with
 *   `acceptTransport`.
 * - **Whose link it is.** After the handshake, the key subduction reports for
 *   the peer must be the device key in its peerId — the one the channel
 *   verified. Document access (subduction-policy.ts) is then decided for that
 *   device.
 * - **One link per device.** A peerId names one boot of a device's engine, so a
 *   reloaded peer returns under a new peerId with the same key. Subduction
 *   knows a peer by its key; the newest boot's link replaces the old one.
 * - **Honest about the end.** When a peer leaves, pending reads fail and
 *   subduction's disconnect callback fires, so it lets go of the device.
 *
 * Subduction's document source does not notice connections made here (it only
 * tracks the ones it opens), so `onLinkUp` exists for the caller to tell the
 * Repo to sync its open documents with the new peer.
 */
import type { Message, NetworkAdapterInterface } from '@automerge/automerge-repo';
import { deviceKeyOfPeerId } from './secure-channel';
import { createLogger } from './logger';

const log = createLogger('links');

/** The message type subduction frames travel as, inside the secure channel. */
export const SUBDUCTION_LINK_MESSAGE = 'subduction-connection';

/** The name both ends of a subduction handshake must present. */
const SERVICE_NAME = 'automerge-drive/doc-sync';

// ── The frame ────────────────────────────────────────────────────────────────
//
//   byte 0      version (1)
//   byte 1      flags: 1 = open (the initiator's first frame of a link)
//                      2 = reset (the sender has dropped this link)
//                      4 = datagram (the payload is the caller's, not subduction's)
//   bytes 2-9   link id: 8 random bytes chosen by the initiator
//   bytes 10-   payload: one subduction frame, or one datagram
//
// Nothing here is signed or numbered: the secure channel authenticates the
// sender and delivers in order. The link id is what tells a frame of a link
// already given up on from the one that replaced it.

const FRAME_VERSION = 1;
const FLAG_OPEN = 1;
const FLAG_RESET = 2;
const FLAG_DATAGRAM = 4;
const LINK_ID_BYTES = 8;
const HEADER_BYTES = 2 + LINK_ID_BYTES;

export interface LinkFrame { flags: number; linkId: Uint8Array; payload: Uint8Array }

export function encodeLinkFrame(frame: LinkFrame): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + frame.payload.byteLength);
  out[0] = FRAME_VERSION;
  out[1] = frame.flags;
  out.set(frame.linkId, 2);
  out.set(frame.payload, HEADER_BYTES);
  return out;
}

/** The frame in `data`, or null if it is not one this version understands. */
export function decodeLinkFrame(data: unknown): LinkFrame | null {
  if (!(data instanceof Uint8Array) || data.byteLength < HEADER_BYTES || data[0] !== FRAME_VERSION) return null;
  return { flags: data[1], linkId: data.slice(2, HEADER_BYTES), payload: data.slice(HEADER_BYTES) };
}

// ── The transport subduction is handed ──────────────────────────────────────

const LINK_CLOSED = 'the link is closed';

/**
 * Subduction's `Transport` over one link: message-preserving (each `sendBytes`
 * arrives as one `recvBytes`), ordered, and — unlike automerge-repo's adapter
 * transport — honest about the end: once the link is gone every pending and
 * later read rejects, and subduction's disconnect callback fires.
 */
export class LinkTransport {
  private queue: Uint8Array[] = [];
  private waiters: Array<{ resolve: (bytes: Uint8Array) => void; reject: (err: Error) => void }> = [];
  private closed = false;
  private disconnectCallback: (() => void) | null = null;

  constructor(
    private readonly send: (bytes: Uint8Array) => void,
    /** Subduction let go of the link itself (a failed handshake, a protocol error). */
    private readonly onReleased: () => void,
  ) {}

  /** A frame arrived for subduction to read. */
  deliver(bytes: Uint8Array): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(bytes); else this.queue.push(bytes);
  }

  /** The link is gone: fail every read and tell subduction. */
  close(): void { this.shut(true); }

  // Subduction's Transport interface ↓

  async sendBytes(bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new Error(LINK_CLOSED);
    this.send(bytes);
  }

  recvBytes(): Promise<Uint8Array> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) return Promise.reject(new Error(LINK_CLOSED));
    return new Promise((resolve, reject) => { this.waiters.push({ resolve, reject }); });
  }

  async disconnect(): Promise<void> {
    if (this.closed) return;
    this.shut(false); // subduction asked: it does not need telling
    this.onReleased();
  }

  onDisconnect(callback: () => void): void { this.disconnectCallback = callback; }

  private shut(tellSubduction: boolean): void {
    if (this.closed) return;
    this.closed = true;
    const waiters = this.waiters;
    this.waiters = [];
    this.queue = [];
    for (const waiter of waiters) waiter.reject(new Error(LINK_CLOSED));
    if (tellSubduction) {
      try { this.disconnectCallback?.(); } catch (err) { log.warn('subduction disconnect callback threw:', err); }
    }
  }
}

// ── The links ────────────────────────────────────────────────────────────────

/** A link that is up: the peer, its device key, and subduction's handle on it. */
export interface LinkedPeer {
  peerId: string;
  /** The device's 32-byte Ed25519 key — its keyhive identity. */
  deviceKey: Uint8Array;
  /** Subduction's `PeerId` for the device (the object `syncWithPeer` takes). */
  subductionPeerId: any;
}

export interface SubductionLinksOptions {
  /** The secure channel: peers it announces are proven, and what it delivers is theirs and in order. */
  channel: NetworkAdapterInterface;
  /** The relay's own peerId — a router, never a peer. */
  relayPeerId: string;
  /** This boot's peerId and the Repo's subduction instance, once they exist. */
  ready: Promise<{ localPeerId: string; subduction: any }>;
  /** Whether a link with this device is wanted. Asked again by `reevaluate()`. */
  mayLink: (deviceKey: Uint8Array) => Promise<boolean>;
  /** A link came up. */
  onLinkUp?: (peer: LinkedPeer) => void;
  /** A link that was up went down. */
  onLinkDown?: (peer: LinkedPeer) => void;
  /** A datagram arrived on a link that is up (see `sendDatagram`). */
  onDatagram?: (peer: LinkedPeer, payload: Uint8Array) => void;
  /** Waits, in ms. Defaults suit production; tests shorten them. */
  timings?: Partial<LinkTimings>;
}

export interface LinkTimings {
  /** How long a handshake may take before the link is dropped and retried. */
  handshakeMs: number;
  /** First retry delay; doubles each attempt. */
  retryBaseMs: number;
  retryMaxMs: number;
}

const DEFAULT_TIMINGS: LinkTimings = { handshakeMs: 15_000, retryBaseMs: 500, retryMaxMs: 15_000 };
/** Attempts after which a peer that never answers is worth a warning. */
const WARN_AFTER_ATTEMPTS = 5;

interface Candidate {
  peerId: string;
  deviceKey: Uint8Array;
  deviceKeyHex: string;
  attempts: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  /** `mayLink` said no; ask again on `reevaluate()`. */
  refused: boolean;
  /** Link frames sent to this peer since it was announced. */
  framesOut: number;
}

interface Link {
  candidate: Candidate;
  id: Uint8Array;
  role: 'initiator' | 'acceptor';
  transport: LinkTransport;
  state: 'handshaking' | 'up' | 'closed';
  /** Whether the opening frame has gone out (the initiator's first carries the open flag). */
  opened: boolean;
  /** Subduction's PeerId for the device, once the handshake has finished. */
  subductionPeerId: any;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const short = (peerId: string) => `${peerId.slice(0, 8)}…${peerId.slice(-8)}`;

export interface SubductionLinks {
  /** The links that are up. */
  linked(): LinkedPeer[];
  /** Total bytes of link frames sent so far, to all peers — for pacing by what a sync round costs. */
  bytesSent(): number;
  /**
   * Send a message of the caller's own to one linked peer, on the link but
   * handed to the peer's `onDatagram`, not to subduction. Fire-and-forget;
   * returns false when there is no link that is up. (Presence travels this
   * way, so it reaches exactly the peers it is meant for.)
   */
  sendDatagram(peerId: string, payload: Uint8Array): boolean;
  /**
   * One line per known peer, for a debug surface: `up`, `handshaking`,
   * `waiting` or `refused`, and how many link frames it has been sent.
   */
  describe(): Array<{ peerId: string; state: 'up' | 'handshaking' | 'waiting' | 'refused'; framesOut: number }>;
  /** Ask `mayLink` again for every peer it refused (keyhive's state changed). */
  reevaluate(): void;
  /** Drop everything and stop listening. */
  stop(): Promise<void>;
}

export function startSubductionLinks(opts: SubductionLinksOptions): SubductionLinks {
  const timings = { ...DEFAULT_TIMINGS, ...opts.timings };
  const candidates = new Map<string, Candidate>();
  const links = new Map<string, Link>();            // by peerId
  const linkByDevice = new Map<string, Link>();     // by device key (hex)
  let stopped = false;
  let sentBytes = 0;
  let me = '';
  let subduction: any = null;

  const ready = opts.ready.then((r) => { me = r.localPeerId; subduction = r.subduction; });

  // Everything that arrives — introductions, departures, frames — is handled
  // one at a time, in arrival order: several steps wait on keyhive or on
  // subduction, and a later event must not act before an earlier one has.
  let inbound: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<void> | void): void => {
    inbound = inbound.then(async () => {
      if (stopped) return;
      await ready;
      if (stopped) return;
      await work();
    }).catch((err) => log.warn('link event failed:', err));
  };

  const initiates = (peerId: string) => me < peerId;
  const peerOf = (link: Link): LinkedPeer => ({
    peerId: link.candidate.peerId, deviceKey: link.candidate.deviceKey, subductionPeerId: link.subductionPeerId,
  });

  // ── sending ──

  function sendFrame(link: Link, flags: number, payload: Uint8Array): void {
    const data = encodeLinkFrame({ flags, linkId: link.id, payload });
    sentBytes += data.byteLength;
    link.candidate.framesOut++;
    try {
      opts.channel.send({
        type: SUBDUCTION_LINK_MESSAGE, senderId: me, targetId: link.candidate.peerId, data,
      } as unknown as Message);
    } catch (err) {
      log.warn(`sending to ${short(link.candidate.peerId)} failed:`, err);
    }
  }

  // ── link lifecycle ──

  function newLink(candidate: Candidate, id: Uint8Array, role: Link['role']): Link {
    const link: Link = {
      candidate, id, role,
      transport: null as unknown as LinkTransport,
      state: 'handshaking', opened: false, subductionPeerId: null,
    };
    link.transport = new LinkTransport(
      (bytes) => {
        const open = link.role === 'initiator' && !link.opened ? FLAG_OPEN : 0;
        link.opened = true;
        sendFrame(link, open, bytes);
      },
      () => enqueue(() => drop(link, 'subduction closed the link', { tellPeer: true, retry: true })),
    );
    links.set(candidate.peerId, link);
    linkByDevice.set(candidate.deviceKeyHex, link);
    return link;
  }

  /**
   * Take a link down. Resolves once subduction has let go of the device, so a
   * replacement link for the same device can be opened straight after.
   */
  async function drop(link: Link, reason: string, how: { tellPeer: boolean; retry: boolean }): Promise<void> {
    if (link.state === 'closed') return;
    const wasUp = link.state === 'up';
    link.state = 'closed';
    const { candidate } = link;
    if (links.get(candidate.peerId) === link) links.delete(candidate.peerId);
    const current = linkByDevice.get(candidate.deviceKeyHex) === link;
    if (current) linkByDevice.delete(candidate.deviceKeyHex);

    if (how.tellPeer) sendFrame(link, FLAG_RESET, new Uint8Array());
    link.transport.close();
    log.info(`link with ${short(candidate.peerId)} down: ${reason}`);

    // Subduction knows the device, not the boot: only let go of it when no
    // newer link for the same device has taken its place.
    if (current && link.subductionPeerId) {
      try { await subduction.disconnectFromPeer(link.subductionPeerId); }
      catch (err) { log.debug('disconnectFromPeer:', err); }
    }
    if (wasUp) opts.onLinkDown?.(peerOf(link));
    if (how.retry && link.role === 'initiator') scheduleRetry(candidate);
  }

  function scheduleRetry(candidate: Candidate): void {
    if (stopped || candidates.get(candidate.peerId) !== candidate || candidate.retryTimer) return;
    candidate.attempts++;
    if (candidate.attempts === WARN_AFTER_ATTEMPTS) {
      log.warn(`no document link with ${short(candidate.peerId)} after ${candidate.attempts} attempts`);
    }
    const backoff = Math.min(timings.retryMaxMs, timings.retryBaseMs * 2 ** (candidate.attempts - 1));
    candidate.retryTimer = setTimeout(() => {
      candidate.retryTimer = null;
      enqueue(() => open(candidate));
    }, backoff * (0.75 + Math.random() * 0.5));
    (candidate.retryTimer as any)?.unref?.();
  }

  /** Run a handshake to its end: the link is up, or it is dropped. */
  async function handshake(link: Link, run: () => Promise<any>): Promise<void> {
    const { candidate } = link;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const remote = await Promise.race([
        run(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('the handshake timed out')), timings.handshakeMs);
          (timer as any)?.unref?.();
        }),
      ]);
      if (link.state !== 'handshaking') return;
      // The channel proved the key in the peerId; subduction must have met that
      // same key, or the document policy would be judging somebody else.
      if (!sameBytes(remote.toBytes(), candidate.deviceKey)) {
        log.warn(`${short(candidate.peerId)} completed the handshake as a different key; dropping the link`);
        link.subductionPeerId = remote;
        await drop(link, 'handshake key does not match the peerId', { tellPeer: true, retry: true });
        return;
      }
      link.subductionPeerId = remote;
      link.state = 'up';
      candidate.attempts = 0;
      log.info(`link with ${short(candidate.peerId)} up (${link.role})`);
      opts.onLinkUp?.(peerOf(link));
    } catch (err) {
      await drop(link, `handshake failed: ${String((err as any)?.message ?? err)}`, { tellPeer: true, retry: true });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Open a link to a peer this side initiates to, if one is wanted. */
  async function open(candidate: Candidate): Promise<void> {
    if (stopped || candidates.get(candidate.peerId) !== candidate || links.has(candidate.peerId)) return;
    if (!initiates(candidate.peerId)) return;
    if (!(await opts.mayLink(candidate.deviceKey))) { candidate.refused = true; return; }
    candidate.refused = false;
    // The newest boot of a device wins: subduction can hold one connection per key.
    const prior = linkByDevice.get(candidate.deviceKeyHex);
    if (prior) await drop(prior, 'the device came back under a new peerId', { tellPeer: true, retry: false });
    const link = newLink(candidate, crypto.getRandomValues(new Uint8Array(LINK_ID_BYTES)), 'initiator');
    void handshake(link, () => subduction.connectTransport(link.transport, SERVICE_NAME));
  }

  // ── receiving ──

  async function onFrame(message: Message): Promise<void> {
    // Only peers the channel announced: a frame from anyone else cannot start a link.
    const candidate = candidates.get((message as any).senderId);
    if (!candidate) return;
    const frame = decodeLinkFrame((message as any).data);
    if (!frame) return;

    let link = links.get(candidate.peerId);
    if (!link || !sameBytes(link.id, frame.linkId)) {
      // A frame for a link this side does not have. Only the initiator's
      // opening frame starts one; anything else belongs to a link given up on.
      if (!(frame.flags & FLAG_OPEN) || initiates(candidate.peerId)) return;
      if (!(await opts.mayLink(candidate.deviceKey))) { candidate.refused = true; return; }
      candidate.refused = false;
      if (link) await drop(link, 'the peer opened a new link', { tellPeer: false, retry: false });
      const prior = linkByDevice.get(candidate.deviceKeyHex);
      if (prior) await drop(prior, 'the device came back under a new peerId', { tellPeer: true, retry: false });
      const accepted = newLink(candidate, frame.linkId, 'acceptor');
      link = accepted;
      void handshake(accepted, () => subduction.acceptTransport(accepted.transport, SERVICE_NAME));
    }
    if (frame.flags & FLAG_RESET) {
      await drop(link, 'the peer dropped the link', { tellPeer: false, retry: true });
      return;
    }
    if (frame.flags & FLAG_DATAGRAM) {
      // A datagram is only meaningful from a peer whose handshake has finished.
      if (link.state !== 'up') return;
      try { opts.onDatagram?.(peerOf(link), frame.payload); } catch (err) { log.warn('datagram handler threw:', err); }
      return;
    }
    link.transport.deliver(frame.payload);
  }

  async function onCandidate(peerId: string): Promise<void> {
    if (peerId === opts.relayPeerId || peerId === me) return;
    let deviceKey: Uint8Array;
    try { deviceKey = deviceKeyOfPeerId(peerId); } catch { return; }

    // Announced again: whatever link there was belongs to a session that ended.
    const stale = links.get(peerId);
    if (stale) await drop(stale, 'the peer was announced again', { tellPeer: false, retry: false });
    const previous = candidates.get(peerId);
    if (previous?.retryTimer) clearTimeout(previous.retryTimer);

    const candidate: Candidate = {
      peerId, deviceKey, deviceKeyHex: hex(deviceKey), attempts: 0, retryTimer: null, refused: false, framesOut: 0,
    };
    candidates.set(peerId, candidate);
    await open(candidate);
  }

  async function onGone(peerId: string): Promise<void> {
    const candidate = candidates.get(peerId);
    if (!candidate) return;
    if (candidate.retryTimer) clearTimeout(candidate.retryTimer);
    candidates.delete(peerId);
    const link = links.get(peerId);
    if (link) await drop(link, 'the peer left', { tellPeer: false, retry: false });
  }

  // ── wiring ──

  const onMessage = (message: Message) => {
    if ((message as any)?.type === SUBDUCTION_LINK_MESSAGE) enqueue(() => onFrame(message));
  };
  const onPeerCandidate = (p: { peerId: string }) => enqueue(() => onCandidate(p.peerId));
  const onPeerDisconnected = (p: { peerId: string }) => enqueue(() => onGone(p.peerId));
  opts.channel.on('message', onMessage as any);
  opts.channel.on('peer-candidate', onPeerCandidate as any);
  opts.channel.on('peer-disconnected', onPeerDisconnected as any);

  return {
    linked: () => [...links.values()].filter((link) => link.state === 'up').map(peerOf),

    bytesSent: () => sentBytes,

    sendDatagram: (peerId, payload) => {
      const link = links.get(peerId);
      if (!link || link.state !== 'up') return false;
      sendFrame(link, FLAG_DATAGRAM, payload);
      return true;
    },

    describe: () => [...candidates.values()].map((candidate) => {
      const link = links.get(candidate.peerId);
      const state = link?.state === 'up' ? 'up' as const
        : link ? 'handshaking' as const
        : candidate.refused ? 'refused' as const
        : 'waiting' as const;
      return { peerId: candidate.peerId, state, framesOut: candidate.framesOut };
    }),

    reevaluate: () => enqueue(async () => {
      for (const candidate of [...candidates.values()]) if (candidate.refused) await open(candidate);
    }),

    stop: async () => {
      if (stopped) return;
      opts.channel.off('message', onMessage as any);
      opts.channel.off('peer-candidate', onPeerCandidate as any);
      opts.channel.off('peer-disconnected', onPeerDisconnected as any);
      await inbound;
      stopped = true;
      await ready.catch(() => {});
      for (const candidate of candidates.values()) if (candidate.retryTimer) clearTimeout(candidate.retryTimer);
      candidates.clear();
      if (subduction) for (const link of [...links.values()]) await drop(link, 'stopping', { tellPeer: false, retry: false });
    },
  };
}
