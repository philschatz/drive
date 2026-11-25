/**
 * Real peers talking through the real relay, in one process, with every frame
 * the relay receives recorded.
 *
 * Nothing here is a stand-in for the parts under test:
 *  - each peer is `createKeyhiveRepo` — the real keyhive WASM, the real keyhive
 *    bridge and a real automerge-repo `Repo` — over the same adapter stack the
 *    CLI builds (WebSocket client adapter → overlay intercept → WebRTC/relay
 *    adapter). No WebRTC bridge is attached unless a test asks (`webrtc: true`),
 *    so by default every peer stays on the relay;
 *  - the relay is `WebSocketRelay` behind a real `ws` server on a loopback port.
 *
 * What IS stood in for is everything above `createKeyhiveRepo`: the engine's
 * discovery declaration, the QR contact exchange and the Sharing page are
 * replaced by the `KeyhiveOps` calls those features make (`befriend`,
 * `createSharedDoc`), and a test hands a document id to the other peer directly
 * instead of waiting for the home list to find it.
 *
 * The recording is taken on the relay's side of each socket, by a listener
 * registered before the relay's own — so `frames` is exactly what a relay
 * operator could log, byte for byte, in arrival order.
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { decode } from 'cbor-x';
import { NetworkAdapter } from '@automerge/automerge-repo';
import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket';
import { WebSocketRelay, createRelayWebSocketServer } from '../../src/relay/relay';
import { createKeyhiveRepo, type KeyhiveRepo } from '../../src/shared/keyhive-repo';
import { installOverlayIntercept, makeOverlayFrameSender } from '../../src/shared/relay-overlay';
import { makeWebRTCRelayAdapter } from '../../src/shared/webrtc-relay-adapter';
import { RELAY_PEER_ID, buildRelayTokenFrame, type RelayTokenFrame } from '../../src/shared/relay-identity';
import { pendingLinkedDevices, type LinkedDevices } from '../../src/shared/discovery-tokens';
import { startWebRTCBridgeCore } from '../../src/shared/webrtc-bridge-core';
import { createWeriftPeerConnection } from '../../src/cli/werift-rtc';
import type { MemberRole } from '../../src/shared/keyhive-types';
import { makeMemStorage, type MemStorage } from './mem-storage';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Poll `check` until it is true; reject with `what` if it never is. */
export async function waitFor(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

// ── The relay ───────────────────────────────────────────────────────────────

/** One frame as the relay received it. */
export interface RecordedFrame {
  /** Position in arrival order. */
  index: number;
  /** The peerId the sending socket joined as ('' for a frame before its join). */
  from: string;
  /** The whole frame, exactly as it arrived. */
  bytes: Uint8Array;
  /** The CBOR envelope's fields, when the frame decodes as one. */
  type?: string;
  targetId?: string;
  data?: Uint8Array;
}

export interface RecordingRelay {
  url: string;
  frames: RecordedFrame[];
  close(): Promise<void>;
}

export async function startRecordingRelay(): Promise<RecordingRelay> {
  const frames: RecordedFrame[] = [];
  const server = http.createServer();
  const wss = createRelayWebSocketServer();
  const relay = new WebSocketRelay();

  wss.on('connection', (ws, req) => {
    let joinedAs = '';
    // Registered before the relay's listener, so this sees every frame it sees.
    ws.on('message', (raw: Buffer) => {
      const bytes = new Uint8Array(raw); // a copy: the relay may reuse the buffer
      let decoded: any;
      try { decoded = decode(bytes); } catch { /* recorded undecoded */ }
      if (decoded?.type === 'join' && typeof decoded.senderId === 'string') joinedAs = decoded.senderId;
      frames.push({
        index: frames.length,
        from: joinedAs,
        bytes,
        type: typeof decoded?.type === 'string' ? decoded.type : undefined,
        targetId: typeof decoded?.targetId === 'string' ? decoded.targetId : undefined,
        data: decoded?.data instanceof Uint8Array ? decoded.data : undefined,
      });
    });
    relay.handleConnection(ws, req);
  });
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `ws://127.0.0.1:${port}`,
    frames,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      // Let the sockets finish closing: the relay logs each departure, and a
      // log line after the test has ended is a Jest error.
      const deadline = Date.now() + 2_000;
      while (wss.clients.size > 0 && Date.now() < deadline) await sleep(10);
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ── A peer ──────────────────────────────────────────────────────────────────

export interface HarnessPeer {
  /** A label for failure messages ('alice'). */
  name: string;
  kr: KeyhiveRepo;
  /** This boot's automerge-repo peerId. */
  peerId: string;
  storage: MemStorage;
  /** The user's keyhive user-group id (base64) — what a friend shares a document with. */
  groupId: string;
  /**
   * Set this peer's friend roster and declare itself to the relay, as the
   * engine's `refreshRelayWatch` does: the discovery tokens for every device it
   * is related to (its own, the roster's, the co-members of its documents) and
   * for a device it was just linked with. Declared again by itself whenever
   * keyhive learns something, since that can change who it is related to.
   */
  watch(knownGroupIds: string[]): void;
  /** The groups this peer last named as its friends. */
  watching(): string[];
  /** The tokens this peer last declared to the relay. */
  declaredTokens(): string[];
  /** The devices this one was linked with that keyhive does not list yet (what the engine keeps in its store). */
  linkedDevices(): LinkedDevices;
  /** Remember the other device of a link just made, as the engine does when a link is accepted. */
  rememberLinkedDevice(agentId: string): void;
  /** Remove one of this user's devices from the user's group, as Settings → Devices does. */
  removeDevice(device: HarnessPeer): Promise<void>;
  /** PeerIds the Repo currently lists as connected, minus the relay itself. */
  connectedPeerIds(): string[];
  /** Cut this peer's relay socket; the adapter reconnects on its own, as after a network blip. */
  dropSocket(): void;
  /** Write an arbitrary frame onto this peer's relay socket (what a modified client could send). */
  sendRelayFrame(frame: unknown): void;
  /** With `webrtc`: the route a peer's traffic is on now. Always 'relay' without it. */
  transportOf(peerId: string): 'direct' | 'relay';
  /** With `webrtc`: the peers this device's RTC stack has been asked to negotiate with, or handed a signal from. */
  directAttempts(): string[];
  /**
   * With `webrtc`: behave as a modified client would — start a direct
   * negotiation with a peer whatever keyhive says about it, as the offering side.
   */
  forceDirectOffer(peerId: string): void;
  close(): Promise<void>;
}

export interface StartPeerOptions {
  /**
   * Boot from an earlier peer's storage and user group — the same device after
   * a reload. It returns under a new peerId (the bridge mints one per boot)
   * with the same device key.
   */
  reloadOf?: HarnessPeer;
  /**
   * Leave every wait at what the app ships with (keyhive's 2 s sync interval
   * and share-config debounce, the channel's and links' own retries) instead
   * of the short ones tests normally run on. For a test that measures what a
   * user would wait for. Only subduction's sync deadline is still shortened:
   * its timer outlives the round and would hold the process open.
   */
  productionTimings?: boolean;
  /**
   * Attach a real WebRTC bridge (werift, host candidates only — nothing leaves
   * loopback), as the CLI does. Without it a peer can never leave the relay.
   */
  webrtc?: boolean;
  /**
   * Start as a new device of that peer's user: linked into its user group the
   * way the QR device link does it (engine-rendezvous.ts), with the contact
   * cards handed over directly. The two are then one user with two devices.
   */
  deviceOf?: HarnessPeer;
}

export async function startPeer(name: string, relayUrl: string, opts: StartPeerOptions = {}): Promise<HarnessPeer> {
  const storage = opts.reloadOf?.storage ?? makeMemStorage();
  let userGroupId: string | null = opts.reloadOf?.groupId ?? null;

  // The CLI's adapter stack (src/cli/cli.ts), minus the WebRTC bridge.
  const ws: any = new WebSocketClientAdapter(relayUrl, 200);
  const sendOverlayFrame = makeOverlayFrameSender(ws);
  const transports = new Map<string, 'direct' | 'relay'>();
  const adapter = makeWebRTCRelayAdapter(NetworkAdapter as any, ws, {
    relayPeerId: RELAY_PEER_ID,
    onTransportChange: (peerId, transport) => { transports.set(peerId, transport); },
  });
  installOverlayIntercept(ws, {
    onRendezvous: () => {},
  });

  // The CLI's WebRTC bridge, with everything the adapter asks of it recorded.
  const directAttempts = new Set<string>();
  let bridgePort: MessagePort | null = null;
  let stopBridge: (() => void) | null = null;
  if (opts.webrtc) {
    const { port1, port2 } = new MessageChannel();
    bridgePort = port1 as unknown as MessagePort;
    const tapped = {
      postMessage: (msg: any, transfer?: any[]) => {
        if (msg?.kind === 'connect-peer' || msg?.kind === 'signal-in') directAttempts.add(msg.peerId);
        if (transfer) (port1 as any).postMessage(msg, transfer); else port1.postMessage(msg);
      },
      set onmessage(fn: any) { (port1 as any).onmessage = fn; },
    };
    adapter.attachPort(tapped as unknown as MessagePort);
    stopBridge = startWebRTCBridgeCore(port2 as unknown as MessagePort, {
      iceServers: [], createPeerConnection: createWeriftPeerConnection,
    });
  }

  // What the engine does on every socket (re)open: the relay's discovery state
  // is per socket, so the declaration is sent again, and sessions made over the
  // previous socket end (the relay re-introduces the peers).
  let kr: KeyhiveRepo | null = null;
  let declared: RelayTokenFrame | null = null;
  // Devices remembered from a link, which the engine keeps in its key-value store.
  let linked: LinkedDevices = { ...(opts.reloadOf?.linkedDevices() ?? {}) };
  let watching = false;
  // What the engine's refreshRelayWatch does: declare the tokens, if they changed.
  const declare = async (): Promise<void> => {
    if (!watching || !kr) return;
    const related = await kr.relations.get();
    linked = pendingLinkedDevices(linked, (key) => related.has(key), Date.now());
    const frame = buildRelayTokenFrame(await kr.discoveryTokens(Object.keys(linked)));
    if (JSON.stringify(frame) === JSON.stringify(declared)) return;
    declared = frame;
    sendOverlayFrame(frame);
  };
  // The friend roster, which the engine keeps in its settings: the groups this
  // peer was last told to watch.
  let roster: string[] = [];
  const origOnOpen = ws.onOpen;
  ws.onOpen = () => {
    origOnOpen();
    kr?.channel.resetAll();
    if (declared) sendOverlayFrame(declared);
  };

  // The options the engine passes (src/shared/drive-engine.ts), with the
  // waits shortened so a test does not sit through production's 2 s rounds —
  // unless the test asked for production's.
  const timings = opts.productionTimings
    ? { subductionTimeouts: { syncMs: 5_000 } }
    : {
      syncRequestInterval: 150,
      shareConfigDebounceMs: 50,
      channelTimings: { helloRetryMs: 200, helloRetryMaxMs: 1_000, gapMs: 500 },
      linkTimings: { handshakeMs: 5_000, retryBaseMs: 100, retryMaxMs: 1_000 },
      // A sync round's deadline timer outlives the round, so the default 60 s
      // would keep the process alive that long after the last test.
      subductionTimeouts: { syncMs: 3_000, defaultMs: 3_000, healInitialDelayMs: 100, healMaxDelayMs: 1_000 },
    };
  kr = await createKeyhiveRepo({
    storage,
    networkAdapter: adapter,
    peerIdSuffix: 'drive',
    getUserGroupId: async () => userGroupId,
    setUserGroupId: async (id) => { userGroupId = id; },
    friendGroupIds: () => roster,
    // Keyhive learned something: who this device is related to may have changed.
    onBeforeShareConfigChanged: () => { kr?.relations.invalidate(); void declare(); },
    ...timings,
  });
  const booted = kr;
  let groupId: string | null;
  if (opts.deviceOf) {
    const first = opts.deviceOf;
    await adapter.whenReady();
    const mine = await first.kr.khOps.receiveContactCard(await booted.khOps.getContactCard());
    const theirs = await booted.khOps.receiveContactCard(await first.kr.khOps.getContactCard());
    // Each remembers the other from the link: presenting that pair's token is
    // how the relay comes to introduce the two before keyhive lists them.
    first.rememberLinkedDevice(mine.agentId);
    linked[theirs.agentId] = Date.now();
    watching = true;
    await declare();
    // The first device (the group's admin) adds this one; this one adopts the
    // group, which waits for the group's operations to arrive.
    await first.kr.khOps.linkDevice(mine.agentId, first.groupId);
    const { userGroupId: adopted } = await booted.khOps.linkDevice(theirs.agentId, first.groupId);
    groupId = adopted;
    first.kr.relations.invalidate();
    booted.relations.invalidate();
  } else {
    groupId = await booted.khOps.ensureUserGroup({ create: true });
    await adapter.whenReady();
  }
  if (!groupId) throw new Error(`${name}: no user group`);
  const ownGroupId = groupId;

  return {
    name,
    kr: booted,
    peerId: booted.repo.peerId,
    storage,
    groupId: ownGroupId,
    watch: (knownGroupIds) => {
      roster = [...knownGroupIds];
      watching = true;
      booted.relations.invalidate();
      void declare();
    },
    watching: () => [...roster],
    declaredTokens: () => [...(declared?.tokens ?? [])],
    linkedDevices: () => ({ ...linked }),
    rememberLinkedDevice: (agentId) => {
      linked[agentId] = Date.now();
      watching = true;
      booted.relations.invalidate();
      void declare();
    },
    removeDevice: async (device) => {
      const { agentId } = await device.kr.khOps.getIdentity();
      await booted.khOps.removeDeviceFromGroup(agentId);
      booted.relations.invalidate();
      void declare();
    },
    connectedPeerIds: () => (booted.repo.peers as string[]).filter((id) => id !== RELAY_PEER_ID),
    dropSocket: () => ws.socket?.close(),
    sendRelayFrame: (frame) => sendOverlayFrame(frame),
    transportOf: (peerId) => transports.get(peerId) ?? 'relay',
    directAttempts: () => [...directAttempts],
    forceDirectOffer: (peerId) => {
      adapter.allowDirect(peerId);
      (bridgePort as any)?.postMessage({ kind: 'connect-peer', peerId, initiator: true });
    },
    close: async () => {
      await booted.close();
      stopBridge?.();
      (bridgePort as any)?.close?.();
    },
  };
}

// ── The app's flows, at the KeyhiveOps level ────────────────────────────────

/**
 * Two users add each other as friends and the relay introduces their devices.
 * The contact bundles are handed over directly, where the app carries them
 * through the QR rendezvous; the discovery declaration is the frame the engine's
 * `refreshRelayWatch` sends.
 */
export async function befriend(a: HarnessPeer, b: HarnessPeer): Promise<void> {
  await a.kr.khOps.receiveContactCard(await b.kr.khOps.getContactCard());
  await b.kr.khOps.receiveContactCard(await a.kr.khOps.getContactCard());
  a.watch([b.groupId]);
  b.watch([a.groupId]);
  await waitFor(
    () => a.connectedPeerIds().includes(b.peerId) && b.connectedPeerIds().includes(a.peerId),
    `the relay to introduce ${a.name} and ${b.name}`,
  );
}

/**
 * `owner` creates a keyhive-backed document, shared with nobody yet — the
 * engine's `createKeyhiveDocHandle`.
 */
export async function createDoc(
  owner: HarnessPeer, content: Record<string, unknown>,
): Promise<{ docId: string; khDocId: string; handle: any }> {
  const { khDocId, docIdBytes } = await owner.kr.khOps.createKeyhiveDoc();
  owner.kr.setNextDocId(docIdBytes);
  const handle = await owner.kr.repo.create2(content);
  await owner.kr.khOps.enableSharing(handle.documentId, docIdBytes);
  return { docId: handle.documentId, khDocId, handle };
}

/** `owner` shares a document with `friend`'s user group — the Sharing page's `addMember`. */
export async function shareDoc(owner: HarnessPeer, friend: HarnessPeer, khDocId: string, role: MemberRole = 'edit'): Promise<void> {
  await owner.kr.khOps.addMember(friend.groupId, khDocId, role);
}

/** {@link createDoc} then {@link shareDoc}. Returns the automerge document id. */
export async function createSharedDoc(
  owner: HarnessPeer, friend: HarnessPeer, content: Record<string, unknown>, role: MemberRole = 'edit',
): Promise<{ docId: string; khDocId: string; handle: any }> {
  const doc = await createDoc(owner, content);
  await shareDoc(owner, friend, doc.khDocId, role);
  return doc;
}

/**
 * Open a document that has to arrive from a peer. `repo.find` rejects while no
 * connected peer offers the document, so — like the engine — keep asking.
 */
export async function openDoc(peer: HarnessPeer, docId: string, timeoutMs = 45_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = 'no attempt finished';
  while (Date.now() < deadline) {
    const attempt: Promise<any> = peer.kr.repo.find(docId);
    attempt.catch(() => {}); // an attempt abandoned below must not surface later
    // Cleared either way: a timer left running would hold the process open
    // after the test that used it has finished.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tooSlow = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('still loading after 3s')), 3_000);
    });
    try {
      return await Promise.race([attempt, tooSlow]);
    } catch (err) {
      lastError = err;
      await sleep(250);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${peer.name} could not open ${docId} within ${timeoutMs}ms: ${String(lastError)}`);
}

/**
 * The commits and fragments that make up `handle`'s document, per Automerge,
 * that are NOT in the peer's sync store. A peer can only give another peer
 * what its sync store holds, so a change that is in the document but not in
 * the store is one no later joiner can get from it.
 *
 * Empty is the invariant only at rest: compaction and the save that stores a
 * new fragment are separate steps. So wait for it rather than sampling it, and
 * assert the thing it protects as well — that a later member can load the
 * document from this peer alone (tests/e2ee-history.test.ts does both).
 */
export function missingFromSyncStore(peer: HarnessPeer, handle: any): string[] {
  const stored = new Set<string>();
  for (const e of peer.storage.store.values()) {
    if (e.key[0] === 'subduction-interceptor' && (e.key[1] === 'commits' || e.key[1] === 'fragments')) stored.add(e.key[3]);
  }
  return (peer.kr.Automerge.getFragmentMetadata(handle.doc()) as { head: string }[])
    .map((m) => m.head)
    .filter((head) => !stored.has(head));
}

// ── Reading the recording ───────────────────────────────────────────────────

/** A place where a document's content was readable in a recorded frame. */
export interface Leak {
  /** The frame's position in the recording. */
  frame: number;
  /** The envelope's `type` ('sync', …), or '(undecoded)'. */
  type: string;
  from: string;
  to: string;
  bytes: number;
  /**
   * `literal`: the marker's own bytes are in the frame.
   * `decoded`: the frame is an Automerge sync message that, applied to an empty
   * document, yields content holding the marker — what an eavesdropper would do
   * if compression had hidden the literal bytes.
   */
  how: 'literal' | 'decoded';
  /** The bytes around the marker (unprintable ones as '·'), or the decoded document. */
  excerpt: string;
}

function printable(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '·')).join('');
}

/**
 * Every recorded frame in which `marker` — a string a test wrote into a
 * document — can be read. `nameOf` turns a peerId into a readable label.
 * `Automerge` is the namespace the peers use (`peer.kr.Automerge`).
 */
export function findLeaks(
  frames: RecordedFrame[], marker: string, Automerge: any, nameOf: (peerId: string) => string = (id) => id,
): Leak[] {
  const needle = Buffer.from(marker, 'utf8');
  const leaks: Leak[] = [];
  for (const f of frames) {
    const base = {
      frame: f.index,
      type: f.type ?? '(undecoded)',
      from: nameOf(f.from),
      to: nameOf(f.targetId ?? ''),
      bytes: f.bytes.byteLength,
    };
    const at = Buffer.from(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength).indexOf(needle);
    if (at >= 0) {
      const around = f.bytes.subarray(Math.max(0, at - 12), Math.min(f.bytes.byteLength, at + needle.length + 12));
      leaks.push({ ...base, how: 'literal', excerpt: printable(around) });
      continue;
    }
    if (f.type === 'sync' && f.data) {
      try {
        const [doc] = Automerge.receiveSyncMessage(Automerge.init(), Automerge.initSyncState(), f.data);
        const json = JSON.stringify(doc);
        if (json.includes(marker)) leaks.push({ ...base, how: 'decoded', excerpt: json.slice(0, 160) });
      } catch { /* not a sync message an outsider can apply on its own */ }
    }
  }
  return leaks;
}
