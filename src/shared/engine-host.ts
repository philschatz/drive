/**
 * Injection interfaces that make DriveEngine environment-agnostic.
 *
 * The engine holds all of the app's sync/keyhive/document logic but performs no
 * direct browser I/O. Each runtime supplies an `EngineHost`:
 *   - browser (automerge-worker.ts): IndexedDB storage, a WebRTC-wrapped
 *     BrowserWebSocket network, an idb-storage-backed KVStore, and
 *     `emit = self.postMessage`.
 *   - node (cli.ts): NodeFS storage, a plain WebSocket network, a JSON-file
 *     KVStore, and `emit` = a logging dispatcher.
 */
import type { SettingName, SettingsSchema } from './storage-keys';
import type { WorkerToMain } from './worker-protocol';
import type { RelayWatchFrame } from './relay-identity';

/**
 * The persistence surface the engine needs (the browser gets this from
 * idb-storage.ts). Keys/prefixes come from storage-keys.ts.
 */
export interface KVStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  /** Delete every entry whose key starts with `prefix`. */
  delPrefix(prefix: string): Promise<void>;
  settingGet<K extends SettingName>(name: K): Promise<SettingsSchema[K]>;
  settingSet<K extends SettingName>(name: K, value: SettingsSchema[K]): Promise<void>;
}

/** A frame the engine sends over the raw relay socket (host CBOR-encodes it):
 *  rendezvous control/data, or the relay discovery declaration (RELAY_WATCH). */
export type OverlayFrame =
  | { type: string; rendezvousId: string; data?: Uint8Array }
  | RelayWatchFrame;

/**
 * Transport abstraction. The host owns the actual socket and the automerge-repo
 * network adapter; the engine only needs to (a) hand the adapter to the repo,
 * (b) send rendezvous/discovery frames, and (c) receive inbound rendezvous
 * frames. WebRTC-signaling frames (browser only) are handled entirely inside
 * the host.
 */
export interface EngineNetwork {
  /**
   * The automerge-repo NetworkAdapter handed to createKeyhiveRepo/new Repo.
   * Optional: in local-only mode (e.g. the CLI's read commands) there is no
   * relay socket, so this is absent and the repo is built with no network.
   */
  networkAdapter?: any;
  /** Send a rendezvous/discovery frame over the raw relay socket (no-op when local-only). */
  sendOverlayFrame(frame: OverlayFrame): void;
  /** Register the engine's inbound-rendezvous-frame handler (no-op when local-only). */
  onRendezvousFrame(handler: (frame: any) => void): void;
  /**
   * Register a callback fired every time the relay socket opens — the first
   * connect AND each reconnect. The adapter sends `join` from its own open
   * handler first, so frames sent from here follow the handshake on the same
   * socket. The engine uses this to (re)send its RELAY_WATCH declaration,
   * which the relay keeps per-socket. Optional: absent when local-only.
   */
  onSocketOpen?(handler: () => void): void;
}

export interface EngineHost {
  /** automerge-repo StorageAdapter (IndexedDBStorageAdapter | NodeFSStorageAdapter). */
  storage: any;
  kv: KVStore;
  network: EngineNetwork;
  /** Where engine events go (browser: self.postMessage; node: a log dispatcher). */
  emit(event: WorkerToMain): void;
}
