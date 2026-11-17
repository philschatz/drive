/**
 * Tab leadership via the Web Locks API.
 *
 * Only one engine may exist per device, and this lock is the ONLY thing that
 * enforces it. (It used to have a backstop: every tab shared one fixed peerId, so
 * the relay refused a second socket. The keyhive bridge now mints a new peerId
 * per engine boot, so two engines would both connect — and pair with each other.)
 *
 * Why one: an engine is one keyhive instance of this device's identity. Two of
 * them each hold key material the other lacks and each write the device's whole
 * keyhive state to the same storage; and presence, version pinning and the
 * WebRTC bridge are all one-per-device by design. Current keyhive recovers from
 * a lost key by rotating, so a second instance is no longer certain to corrupt
 * the first — but running two is not a supported or tested mode.
 *
 * The lock elects the tab that owns the engine: the leader boots the Worker and
 * routes for everyone else (ui/tab-transport.ts), so extra tabs edit and sync
 * normally rather than sitting idle behind a warning.
 *
 * The first tab acquires an exclusive lock and holds it for its lifetime; any
 * other tab's request stays pending → that tab is *secondary*. When the leader
 * closes or crashes the lock auto-releases and a waiting tab becomes leader.
 *
 * A dedicated Worker cannot outlive its tab and the lock releases exactly when the
 * tab dies, so two engines are never live at once — the property the whole design
 * rests on.
 */
import { createLogger } from '../../shared/logger';

const log = createLogger('tab');

const LOCK_NAME = 'drive-tab-leader';

/**
 * Observe whether this tab is a *secondary* tab (another tab already holds the
 * singleton lock). Calls `onChange(true)` while secondary and `onChange(false)`
 * once this tab holds the lock (it's the leader). Returns a cleanup function.
 */
export function watchTabLeadership(onChange: (isSecondary: boolean) => void): () => void {
  // No Web Locks (old browser / non-secure context, e.g. plain http on a LAN
  // address) — assume a sole tab. Nothing else stops a second tab from booting a
  // second engine here, so say so once rather than fail silently.
  if (typeof navigator === 'undefined' || !navigator.locks?.request) {
    if (typeof navigator !== 'undefined') {
      log.warn('Web Locks are unavailable: opening this app in a second tab will start a second engine on the same data');
    }
    onChange(false);
    return () => {};
  }

  let torndown = false;
  let releaseHold: (() => void) | null = null;
  const abort = new AbortController();

  // Initial state without waiting for leadership: if the lock is already held
  // (by another tab), we're secondary. Avoids a banner flash on the first tab.
  navigator.locks
    .query?.()
    .then((state) => {
      if (torndown) return;
      const held = (state.held ?? []).some((l) => l.name === LOCK_NAME);
      if (held) onChange(true);
    })
    .catch(() => {});

  // Become (or, once the leader closes, become) the leader and hold the lock for
  // this tab's lifetime. The callback runs only once we hold it exclusively.
  navigator.locks
    .request(LOCK_NAME, { mode: 'exclusive', signal: abort.signal }, () =>
      new Promise<void>((resolve) => {
        releaseHold = resolve;
        if (!torndown) onChange(false); // we are now the leader
      })
    )
    .catch(() => {
      /* AbortError on teardown (still pending) — nothing to do */
    });

  return () => {
    torndown = true;
    abort.abort(); // drop the request if we never became leader
    releaseHold?.(); // release the lock if we held it
  };
}
