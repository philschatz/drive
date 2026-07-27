import { useState } from 'preact/hooks';
import { useWsStatus, usePeerTransports, getWorkerPeerId } from './automerge';
import { getWorkerUserGroupId } from '../worker-api';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { dedupePeers, peerDisplayName, peerIdentityKey, PeerDot, type PresenceState } from './presence';

interface PeerLike {
  peerId: string;
  value?: PresenceState | null;
}

/**
 * Relay connection status indicator. Tapping it opens a bottom sheet listing
 * the peers on this document and whether each is connected directly (P2P) or
 * via the relay. (The connection-debug page is reachable from Settings.)
 *
 * Reused by Home and the DocumentTitleBar.
 */
export function ConnectionStatus<P extends PeerLike>({
  className = '',
  peers = [],
  peerTitle,
  hideDots = false,
}: {
  className?: string;
  /** Presence peers to list in the sheet (deduped to other users). */
  peers?: P[];
  peerTitle?: (peer: P) => string;
  /** Hide the inline peer-dot row in the button (the sheet still lists peers). */
  hideDots?: boolean;
}) {
  const connected = useWsStatus();
  const transports = usePeerTransports();
  const [open, setOpen] = useState(false);

  const visible = dedupePeers(peers, getWorkerPeerId(), getWorkerUserGroupId());

  return (
    <>
      {/* One button: peer dots + status icon — tapping either opens the sheet.
          (The text label was pure noise on a narrow bar; the accessible name
          still reads "Connected"/"Disconnected".)

          Disconnected from the relay there are no peers and no transports to
          report, so the button is disabled (dimmed to the MD3 38% disabled
          opacity) rather than recoloured — the greyed-out control is the
          offline signal. */}
      <button
        aria-label={connected ? 'Connected' : 'Disconnected'}
        disabled={!connected}
        className={
          'inline-flex items-center gap-2 ' +
          (connected ? 'cursor-pointer hover:opacity-80 ' : 'cursor-default opacity-[0.38] ') +
          className
        }
        title={connected
          ? 'Connected to relay. Tap for peer details.'
          : 'Not connected to relay.'}
        onClick={() => setOpen(true)}
      >
        {/* Peer dots — clipped to ~4 dots on narrow screens. Devices of the same user
            collapse to a single dot (keyed by user-group id); all of the local user's
            own devices are hidden, not just the current one. (Omitted when empty so
            the button's gap doesn't leave a hole before the icon.) */}
        {!hideDots && visible.length > 0 && (
          <div className="flex items-center gap-1 max-w-[72px] sm:max-w-none overflow-hidden">
            {visible.map(peer => (
              <PeerDot
                key={peerIdentityKey(peer.peerId, peer.value?.userGroupId)}
                peerId={peer.peerId}
                userGroupId={peer.value?.userGroupId}
                direct={transports[peer.peerId] === 'direct'}
                label={peerTitle ? peerTitle(peer) : peerDisplayName(peer.peerId, peer.value?.userGroupId)}
                sizeClass="w-3 h-3"
              />
            ))}
          </div>
        )}
        <span
          className="material-symbols-outlined shrink-0 text-on-surface-variant"
          style={{ fontSize: 20 }}
          aria-hidden="true"
        >
          {connected ? 'wifi_password' : 'wifi_off'}
        </span>
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="max-h-[70vh]">
          <SheetHeader>
            <SheetTitle>Connection</SheetTitle>
          </SheetHeader>

          <div className="mt-3 flex items-center gap-2 text-sm">
            <span
              className="material-symbols-outlined shrink-0 text-on-surface-variant"
              style={{ fontSize: 20 }}
              aria-hidden="true"
            >
              {connected ? 'wifi_password' : 'wifi_off'}
            </span>
            {connected ? 'Connected to relay' : 'Not connected to relay'}
          </div>

          <div className="mt-4">
            <h3 className="text-sm font-medium mb-2">Peers on this document</h3>
            {visible.length === 0 && (
              <p className="text-xs text-muted-foreground">No one else is here right now.</p>
            )}
            {visible.map(peer => {
              const direct = transports[peer.peerId] === 'direct';
              return (
                <div key={peer.peerId} className="flex items-center gap-3 py-2 border-b border-border">
                  <PeerDot
                    peerId={peer.peerId}
                    userGroupId={peer.value?.userGroupId}
                    direct={direct}
                    label={peerTitle ? peerTitle(peer) : peerDisplayName(peer.peerId, peer.value?.userGroupId)}
                    sizeClass="w-3 h-3"
                  />
                  <span className="text-sm flex-1 truncate">
                    {peerTitle ? peerTitle(peer) : peerDisplayName(peer.peerId, peer.value?.userGroupId)}
                  </span>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {direct ? 'P2P' : 'Via relay'}
                  </span>
                </div>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
