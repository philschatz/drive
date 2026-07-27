/**
 * Tab leadership via the Web Locks API.
 *
 * Multiple tabs of this app on one device cannot both sync: they share one
 * peerId (`<agentId>-drive`), so the relay rejects the second tab's join and a
 * sibling tab's presence encrypt would hit the keyhive CGKA panic (see the
 * `same-device-multitab-sync` memory). We detect the extra tab(s) so the UI can
 * warn the user (see the multi-tab notice in components/Notifications.tsx).
 *
 * The first tab acquires an exclusive lock and holds it for its lifetime; any
 * other tab's request stays pending → that tab is *secondary*. When the leader
 * closes or crashes the lock auto-releases and a waiting tab becomes leader.
 */
const LOCK_NAME = 'drive-tab-leader';

/**
 * Observe whether this tab is a *secondary* tab (another tab already holds the
 * singleton lock). Calls `onChange(true)` while secondary and `onChange(false)`
 * once this tab holds the lock (it's the leader). Returns a cleanup function.
 */
export function watchTabLeadership(onChange: (isSecondary: boolean) => void): () => void {
  // No Web Locks (old browser / non-secure context) — assume a sole tab.
  if (typeof navigator === 'undefined' || !navigator.locks?.request) {
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
