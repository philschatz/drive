/**
 * Real peers talking through the real relay, in one process, with every frame
 * the relay receives recorded.
 *
 * Nothing here is a stand-in for the parts under test:
 *  - each peer is `createKeyhiveRepo` — the real keyhive WASM, the real keyhive
 *    bridge and a real automerge-repo `Repo` — over the same adapter stack the
 *    CLI builds (WebSocket client adapter → overlay intercept → WebRTC/relay
 *    adapter; no WebRTC bridge is attached, so every peer stays on the relay);
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
import { RELAY_PEER_ID, buildRelayWatchFrame } from '../../src/shared/relay-identity';
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
  /** Tell the relay who this peer is and whose devices it wants to be introduced to. */
  watch(knownGroupIds: string[]): void;
  /** PeerIds the Repo currently lists as connected, minus the relay itself. */
  connectedPeerIds(): string[];
  close(): Promise<void>;
}

export async function startPeer(name: string, relayUrl: string): Promise<HarnessPeer> {
  const storage = makeMemStorage();
  let userGroupId: string | null = null;

  // The CLI's adapter stack (src/cli/cli.ts), minus the WebRTC bridge.
  const ws: any = new WebSocketClientAdapter(relayUrl, 200);
  const sendOverlayFrame = makeOverlayFrameSender(ws);
  const adapter = makeWebRTCRelayAdapter(NetworkAdapter as any, ws, {
    sendSignalFrame: sendOverlayFrame,
    relayPeerId: RELAY_PEER_ID,
  });
  installOverlayIntercept(ws, {
    onRendezvous: () => {},
    onWebRTCSignal: (frame) => adapter.handleSignal(frame),
  });

  // The options the engine passes (src/shared/drive-engine.ts), with the two
  // waits shortened so a test does not sit through production's 2 s rounds.
  const kr = await createKeyhiveRepo({
    storage,
    networkAdapter: adapter,
    peerIdSuffix: 'drive',
    getUserGroupId: async () => userGroupId,
    setUserGroupId: async (id) => { userGroupId = id; },
    serialize: true,
    withShareConfig: true,
    syncRequestInterval: 150,
    shareConfigDebounceMs: 50,
  });
  const groupId = await kr.khOps.ensureUserGroup({ create: true });
  if (!groupId) throw new Error(`${name}: no user group`);
  await adapter.whenReady();

  return {
    name,
    kr,
    peerId: kr.repo.peerId,
    storage,
    groupId,
    watch: (knownGroupIds) => sendOverlayFrame(buildRelayWatchFrame(groupId, knownGroupIds)),
    connectedPeerIds: () => (kr.repo.peers as string[]).filter((id) => id !== RELAY_PEER_ID),
    close: () => kr.close(),
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
 * `owner` creates a keyhive-backed document and shares it with `friend`'s user
 * group — the engine's `createKeyhiveDocHandle` followed by the Sharing page's
 * `addMember`. Returns the automerge document id.
 */
export async function createSharedDoc(
  owner: HarnessPeer, friend: HarnessPeer, content: Record<string, unknown>, role: MemberRole = 'edit',
): Promise<{ docId: string; khDocId: string; handle: any }> {
  const { khDocId, docIdBytes } = await owner.kr.khOps.createKeyhiveDoc();
  owner.kr.setNextDocId(docIdBytes);
  const handle = await owner.kr.repo.create2(content);
  await owner.kr.khOps.enableSharing(handle.documentId, docIdBytes);
  await owner.kr.khOps.addMember(friend.groupId, khDocId, role);
  return { docId: handle.documentId, khDocId, handle };
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
