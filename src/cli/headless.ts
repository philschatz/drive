/**
 * The headless engine bootstrap: stand a DriveEngine up from a data directory,
 * with or without the relay. No side effects at import, so it is a library:
 * `cli.ts` drives it, and so does the scripts repo's drive-sync service
 * (`~/code/mine/scripts/services/drive-sync/`), which runs its own long-lived
 * sync program on it. `cli.ts sync` documents that same loop.
 *
 * Storage model (see src/shared/keyhive-repo.ts + node-kvstore.ts):
 *   ${dataDir}/secure   NodeFS repo store — automerge docs AND the keyhive device
 *                       identity (so this device is stable across restarts).
 *   ${dataDir}/kv.json   app metadata — the user-group id + doc list.
 *
 * Only one engine may ever use a data directory at a time (CLAUDE.md, "Tabs &
 * the single engine").
 */
import * as fs from 'fs';
import * as path from 'path';
import { NetworkAdapter } from '@automerge/automerge-repo';
import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket';
import { NodeFSStorageAdapter } from '@automerge/automerge-repo-storage-nodefs';
import { PRODUCTION_RELAY_URL, RELAY_PEER_ID } from '../shared/relay-identity';
import { makeWebRTCRelayAdapter } from '../shared/webrtc-relay-adapter';
import { installOverlayIntercept, makeOverlayFrameSender } from '../shared/relay-overlay';
import { startNodeWebRTCBridge } from './webrtc-node-bridge';
import { DriveEngine, type DriveEngineInstance } from '../shared/drive-engine';
import { NodeKVStore } from './node-kvstore';
import { initSubductionNode } from './keyhive-node-shim';
import { KEYS } from '../shared/storage-keys';
import type { EngineHost, EngineNetwork } from '../shared/engine-host';
import type { WorkerToMain } from '../shared/worker-protocol';
import { createLogger, type Logger } from '../shared/logger';

export type { DriveEngineInstance, WatchUpdate } from '../shared/drive-engine';
export { PRODUCTION_RELAY_URL } from '../shared/relay-identity';
export { NodeKVStore } from './node-kvstore';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Where the data directory is when neither a flag nor AUTOMERGE_DATA_DIR names one. */
export const DEFAULT_DATA_DIR = './.data/cli';

/** Resolve the data directory the same way whether or not the engine is started yet. */
export function resolveDataDir(dataDir?: string): string {
  return dataDir ?? process.env.AUTOMERGE_DATA_DIR ?? DEFAULT_DATA_DIR;
}

/**
 * Exit status when the stored keyhive state needs a reset (sysexits EX_CONFIG).
 * Distinct from 1 so a supervisor can tell "will fail the same way every time"
 * from a crash worth restarting.
 */
export const EXIT_RESET_REQUIRED = 78;

/**
 * The keyhive state on disk predates this build's keyhive and cannot be read
 * (src/shared/keyhive-format.ts). Nothing was booted or changed. There is
 * deliberately no flag to wipe it: a headless peer only holds replicas, so the
 * remedy is a fresh data dir — and a wipe switch in a service unit would fire on
 * every restart. The message carries that remedy; exit with `exitCode`.
 */
export class ResetRequiredError extends Error {
  readonly exitCode = EXIT_RESET_REQUIRED;
  constructor(message: string) { super(message); this.name = 'ResetRequiredError'; }
}

/**
 * A do-nothing NetworkAdapter for local-only use (the CLI's list/show/diff).
 * It reports ready immediately and never discovers a peer, so the repo runs purely
 * against local storage and nothing ever dials the relay. We can't pass `undefined`
 * to the keyhive bridge — it wraps whatever adapter it's given and calls `.on()`,
 * `.connect()`, `.isReady()` on it — so this stub satisfies that contract with no I/O.
 */
class OfflineNetworkAdapter extends NetworkAdapter {
  isReady(): boolean { return true; }
  whenReady(): Promise<void> { return Promise.resolve(); }
  connect(): void { /* no peers, ever */ }
  send(): void { /* nothing to send */ }
  disconnect(): void { /* nothing to close */ }
}

export interface HeadlessOptions {
  /** Default: resolveDataDir(). */
  dataDir?: string;
  /** Relay WebSocket URL. Default: DRIVE_RELAY_URL, else the production relay. */
  relayUrl?: string;
  /**
   * `true`: open the relay WebSocket and wire the rendezvous overlay and the
   * WebRTC upgrade; `wsAdapter` in the result is that socket. `false`:
   * local-only — no socket is opened, an OfflineNetworkAdapter stands in so
   * nothing ever dials the relay, and `wsAdapter` is null.
   */
  network: boolean;
  /** Where the bootstrap and engine events are logged. Default: the `headless` namespace. */
  log?: Logger;
}

export interface HeadlessEngine {
  engine: DriveEngineInstance;
  kv: NodeKVStore;
  wsAdapter: any;
  /** Stops the in-process WebRTC bridge (null when local-only). */
  stopBridge: (() => void) | null;
}

/** The app-metadata store of a data directory. Reading it creates no files. */
export function openKV(dataDir?: string): NodeKVStore {
  return new NodeKVStore(path.join(resolveDataDir(dataDir), 'kv.json'));
}

/** Whether this device already has a linked identity (accept-invite has run). */
export async function isLinked(kv: NodeKVStore): Promise<boolean> {
  return !!(await kv.get<string>(KEYS.userGroupId));
}

/**
 * Build the node EngineHost and initialize the engine. Throws
 * ResetRequiredError when the stored keyhive state cannot be read.
 */
export async function startEngine(opts: HeadlessOptions): Promise<HeadlessEngine> {
  const log = opts.log ?? createLogger('headless');
  const dataDir = resolveDataDir(opts.dataDir);

  // Initialize the subduction WASM for Node before the Repo is created (in
  // engine.init).
  await initSubductionNode();

  fs.mkdirSync(dataDir, { recursive: true });
  const secureDir = path.join(dataDir, 'secure');
  fs.mkdirSync(secureDir, { recursive: true });

  const kv = new NodeKVStore(path.join(dataDir, 'kv.json'));
  const storage = new NodeFSStorageAdapter(secureDir);

  let wsAdapter: any = null;
  let stopBridge: (() => void) | null = null;
  let network: EngineNetwork;
  if (opts.network) {
    const relayUrl = opts.relayUrl ?? process.env.DRIVE_RELAY_URL ?? PRODUCTION_RELAY_URL;
    log.info(`relay=${relayUrl} data-dir=${dataDir}`);
    wsAdapter = new WebSocketClientAdapter(relayUrl);
    let rdvHandler: ((frame: any) => void) | null = null;
    const sendOverlayFrame = makeOverlayFrameSender(wsAdapter);

    // Wrap the relay adapter so peers can be upgraded to direct WebRTC data
    // channels — same adapter the browser worker uses; the peer connections
    // live in the in-process werift bridge.
    const p2pAdapter = makeWebRTCRelayAdapter(NetworkAdapter as any, wsAdapter, {
      sendSignalFrame: sendOverlayFrame,
      onTransportChange: (peerId, transport) => emit({ type: 'p2p-status', peerId, transport }),
      relayPeerId: RELAY_PEER_ID,
    });
    const { port1, port2 } = new MessageChannel();
    p2pAdapter.attachPort(port1 as unknown as MessagePort);
    stopBridge = startNodeWebRTCBridge(port2 as unknown as MessagePort);

    // Intercept overlay frames off the raw socket before the repo sees them.
    installOverlayIntercept(wsAdapter, {
      onRendezvous: (frame) => rdvHandler?.(frame),
      onWebRTCSignal: (frame) => p2pAdapter.handleSignal(frame),
    });

    // Notify the engine on every socket (re)open so it re-sends its RELAY_WATCH
    // declaration — the relay's discovery state is per-socket. The adapter's own
    // onOpen (which sends `join`) runs first, same pattern as the browser worker.
    let socketOpenHandler: (() => void) | null = null;
    const origOnOpen = wsAdapter.onOpen;
    wsAdapter.onOpen = () => { origOnOpen(); socketOpenHandler?.(); };

    network = {
      networkAdapter: p2pAdapter,
      sendOverlayFrame,
      onRendezvousFrame: (handler) => { rdvHandler = handler; },
      onSocketOpen: (handler) => { socketOpenHandler = handler; },
    };
  } else {
    // Local-only: no relay socket, no rendezvous overlay. The OfflineNetworkAdapter
    // keeps the keyhive bridge + repo happy while guaranteeing zero network I/O.
    log.info(`local-only data-dir=${dataDir}`);
    network = {
      networkAdapter: new OfflineNetworkAdapter(),
      sendOverlayFrame: () => { /* no relay in local-only mode */ },
      onRendezvousFrame: () => { /* no relay in local-only mode */ },
    };
  }

  const emit = (event: WorkerToMain): void => {
    // Log every emitted engine event. A few get a friendlier one-line summary;
    // the rest fall through to a generic dump so nothing is dropped.
    switch (event.type) {
      case 'ready': log.info(`ready, peerId=${event.peerId}`); return;
      case 'kh-ready': log.info('keyhive ready'); return;
      case 'kh-error': log.error('keyhive error:', event.message); return;
      case 'error': log.error('error:', event.message); return;
      case 'data-warning': log.warn('warning:', event.message); return;
      case 'reset-required': return; // reported with the remedy, right after init()
      case 'peer-connected':
      case 'peer-disconnected': log.info(`peers: ${event.peerCount}`); return;
      case 'p2p-status': log.info(`p2p ${event.peerId} → ${event.transport}`); return;
      case 'doc-list-updated': log.info(`doc list: ${event.list.length} doc(s)`); return;
      case 'kh-rdv-event':
        log.info(`link ${event.status}${event.message ? `: ${event.message}` : ''}`); return;
      default: log.info(`event ${event.type}`, event); return;
    }
  };

  const host: EngineHost = { storage, kv, network, emit };
  const engine = new DriveEngine(host);
  await engine.init();

  if (engine.resetRequired) {
    stopBridge?.();
    throw new ResetRequiredError(
      `The keyhive data in ${secureDir} was written by an older version and this one cannot read it ` +
      `(${engine.resetRequired.reason}). Nothing was changed. To continue: stop the service, move ` +
      `${dataDir} aside, and run \`accept-invite\` again with a new link from a device that has been reset.`,
    );
  }
  return { engine, kv, wsAdapter, stopBridge };
}

/** Poll (up to `attempts` seconds) for the keyhive group graph to sync so accessible docs surface. */
export async function waitForDocs(engine: DriveEngineInstance, attempts = 20, log: Logger = createLogger('headless')): Promise<string[]> {
  log.info('waiting for documents to sync…');
  let ids: string[] = [];
  for (let i = 0; i < attempts; i++) {
    ids = await engine.enumerateAccessibleDocIds();
    if (ids.length) break;
    await sleep(1000);
  }
  return ids;
}
