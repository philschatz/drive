/**
 * The adapter the keyhive bridge — and through it the Repo's classic network
 * subsystem — is given: the secure channel, narrowed to keyhive's own
 * messages.
 *
 * automerge-repo runs its classic sync protocol on every Repo, beside
 * subduction, and that protocol sends documents as plain Automerge sync
 * messages. Document sync is on subduction now (subduction-links.ts), where
 * commits are encrypted; the classic path must not carry anything. The Repo is
 * told to share nothing (`shareConfig` denies every peer), which stops it
 * *generating* sync messages. This adapter is the second lock, at the wire: of
 * everything the Repo and the bridge try to send, and everything a peer sends
 * us, only `keyhive-*` messages — keyhive's signed membership sync — get
 * through. A classic `sync`, `request` or `ephemeral` is dropped in both
 * directions, so no setting, bug or old peer can put a plaintext document on
 * the wire or have one accepted off it.
 *
 * Peer lifecycle events pass untouched: the bridge needs them to sync keyhive
 * with a peer, and the Repo's peer list (the UI's "connected" dots) is built
 * from them.
 */
import type { Message, NetworkAdapterInterface, PeerId, PeerMetadata } from '@automerge/automerge-repo';
import { createLogger } from './logger';

const log = createLogger('doc-sync');

/** Minimal shape of the automerge-repo `NetworkAdapter` base class we extend. */
type NetworkAdapterBase = new () => NetworkAdapterInterface & { emit: (event: string, payload?: unknown) => void };

/** Message types other listeners on the channel handle (see the inbound filter). */
const CHANNEL_OWN_TYPES = new Set<string>(['subduction-connection', 'wrtc-signal']);

const isKeyhiveMessage = (message: Message | undefined): boolean =>
  typeof message?.type === 'string' && message.type.startsWith('keyhive-');

export function makeKeyhiveOnlyAdapter(Base: NetworkAdapterBase, channel: NetworkAdapterInterface): NetworkAdapterInterface {
  const raw = channel;
  // Message types already reported, so a chatty old peer is one line, not a flood.
  const reported = new Set<string>();
  const report = (direction: 'outbound' | 'inbound', message: Message) => {
    const key = `${direction}:${message?.type}`;
    if (reported.has(key)) return;
    reported.add(key);
    // Outbound is the Repo's own classic machinery (e.g. a `doc-unavailable`
    // reply), expected and harmless. Inbound means a peer is still speaking
    // classic sync — an older build.
    if (direction === 'inbound') log.warn(`dropping a classic "${message?.type}" message from a peer (an older build?)`);
    else log.debug(`not sending a classic "${message?.type}" message`);
  };

  class KeyhiveOnlyAdapter extends (Base as NetworkAdapterBase) {
    constructor() {
      super();
      raw.on('message', (message: Message) => {
        if (isKeyhiveMessage(message)) this.emit('message', message);
        // Not classic sync, and not for the bridge: subduction-connection
        // frames are for subduction-links.ts and wrtc-signal for the direct-
        // connection wiring in keyhive-repo.ts, both of which listen on the
        // channel themselves.
        else if (!CHANNEL_OWN_TYPES.has(message?.type)) report('inbound', message);
      });
      raw.on('close', () => this.emit('close'));
      raw.on('peer-candidate', (p: { peerId: PeerId; peerMetadata: PeerMetadata }) => this.emit('peer-candidate', p));
      raw.on('peer-disconnected', (p: { peerId: PeerId }) => this.emit('peer-disconnected', p));
    }

    connect(peerId: PeerId, peerMetadata?: PeerMetadata): void {
      this.peerId = peerId;
      this.peerMetadata = peerMetadata;
      raw.connect(peerId, peerMetadata);
    }

    send(message: Message): void {
      if (isKeyhiveMessage(message)) raw.send(message);
      else report('outbound', message);
    }

    disconnect(): void { raw.disconnect(); }
    isReady(): boolean { return raw.isReady(); }
    whenReady(): Promise<void> { return raw.whenReady(); }
    state() { return raw.state(); }
  }

  return new KeyhiveOnlyAdapter() as unknown as NetworkAdapterInterface;
}
