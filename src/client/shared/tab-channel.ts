/**
 * Cross-tab wire envelope.
 *
 * Exactly one engine may exist per device: the keyhive archive is a single fixed
 * IndexedDB key written as a whole-state snapshot, and CGKA leaf secrets live only
 * in WASM memory plus that snapshot — so two engines silently destroy each other's
 * key material (see keyhive-repo.ts's persistArchive comment). Rather than run one
 * worker per tab, the tab that wins the `drive-tab-leader` Web Lock owns the single
 * dedicated Worker and every other tab RPCs to it over a `BroadcastChannel`.
 *
 * This module is only the envelope vocabulary — `ui/tab-router.ts` implements the
 * leader half and `ui/tab-transport.ts` the follower half. It lives in
 * `client/shared/` because both halves import it and neither thread owns it.
 *
 * `BroadcastChannel` cannot carry transferables, so no envelope may contain a
 * `MessagePort` — that is why the HyperFormula worker proxies its subscriptions
 * through the main thread instead of being handed a port into the engine.
 */
import type { WorkerToMain } from '../../shared/worker-protocol';

/** One bus per origin. All tabs of the app join it. */
export const TAB_CHANNEL_NAME = 'drive-tab-bus';

/** The leader's own WorkerClient is always client 0. Followers get 1, 2, … */
export const LEADER_CLIENT_ID = 0;

/** How often a follower announces it is still alive. */
export const TAB_HEARTBEAT_MS = 3_000;

/**
 * How long the leader waits before pruning a silent client. Must comfortably
 * exceed TAB_HEARTBEAT_MS — a background tab's timers are throttled, and pruning a
 * live tab would tear down subscriptions it is still using.
 */
export const TAB_HEARTBEAT_TIMEOUT_MS = 15_000;

export type ClientId = number;

export type TabEnvelope =
  /** Follower → all: "is there a leader?". `nonce` identifies the sender pre-clientId. */
  | { kind: 'hello'; nonce: string }
  /**
   * Leader → one follower: your clientId, the leader's `epoch`, plus the sticky
   * lifecycle messages a cold client would otherwise never see (`ready`,
   * `kh-ready`, `ws-status`, …) because the worker only emits them on transitions.
   *
   * The epoch must ride along here, not just on `leader-up`: a tab that opens after
   * the leader started never saw that announcement, and a follower which doesn't
   * know whose router it is bound to cannot tell a later leader change from its own.
   */
  | { kind: 'welcome'; nonce: string; clientId: ClientId; epoch: string; replay: WorkerToMain[] }
  /**
   * Leader → all: "a new leader is serving". Any tab already bound to a *previous*
   * leader must reload — its in-flight request ids and live subscriptions were
   * registered in a router that no longer exists.
   */
  | { kind: 'leader-up'; epoch: string }
  /** Leader → all: still alive. Absence is how a follower notices a dead leader. */
  | { kind: 'leader-beat'; epoch: string }
  /** Follower → leader: a MainToWorker message to forward into the engine. */
  | { kind: 'req'; clientId: ClientId; msg: any }
  /** Leader → one follower: a WorkerToMain message addressed to it. */
  | { kind: 'res'; clientId: ClientId; msg: WorkerToMain }
  /** Leader → all followers: a WorkerToMain message every tab needs. */
  | { kind: 'bcast'; msg: WorkerToMain }
  /** Follower → leader: still alive. */
  | { kind: 'beat'; clientId: ClientId }
  /** Follower → leader: leaving; drop my subscriptions. */
  | { kind: 'bye'; clientId: ClientId }
  /**
   * Follower → leader: terminate the Worker so it releases its IndexedDB
   * connections. `deleteAllData`'s `deleteDatabase` blocks until they close, and a
   * follower has no Worker of its own to terminate.
   */
  | { kind: 'shutdown'; clientId: ClientId }
  /**
   * Wiping tab → all: local data is being deleted. Every other tab must close its
   * `app-storage` handle and stop touching IndexedDB (a reopened connection would
   * block the delete), then reload once `wiped` arrives.
   */
  | { kind: 'wipe' }
  | { kind: 'wiped' };

/** Minimal BroadcastChannel surface, so tests can supply a fake bus. */
export interface TabBus {
  postMessage(msg: TabEnvelope): void;
  onmessage: ((e: { data: TabEnvelope }) => void) | null;
  close(): void;
}

/** A random per-tab nonce. Only needs to be unique among concurrently-open tabs. */
export function tabNonce(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
