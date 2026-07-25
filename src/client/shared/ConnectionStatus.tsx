import { useState } from 'preact/hooks';
import { useWsStatus, usePeerTransports, getWorkerPeerId } from './automerge';
import { getWorkerUserGroupId } from '../worker-api';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { dedupePeers, peerDisplayName, PeerDot, type PresenceState } from './presence';

interface PeerLike {
  peerId: string;
  value?: PresenceState | null;
}

/**
 * Relay connection status indicator. Tapping it opens a bottom sheet listing
 * the peers on this document and whether each is connected directly (P2P) or
 * via the relay. (The connection-debug page is reachable from Settings.)
 *
 * Reused by Home (with a colored status dot) and the EditorTitleBar (label only).
 */
export function ConnectionStatus<P extends PeerLike>({
  showDot = false,
  className = '',
  peers = [],
  peerTitle,
}: {
  showDot?: boolean;
  className?: string;
  /** Presence peers to list in the sheet (deduped to other users). */
  peers?: P[];
  peerTitle?: (peer: P) => string;
}) {
  const connected = useWsStatus();
  const transports = usePeerTransports();
  const [open, setOpen] = useState(false);

  const visible = dedupePeers(peers, getWorkerPeerId(), getWorkerUserGroupId());

  return (
    <>
      <button
        className={`flex items-center gap-2 cursor-pointer hover:opacity-80 ${className}`}
        title={connected
          ? 'Connected to relay. Tap for peer details.'
          : 'Not connected to relay. Tap for peer details.'}
        onClick={() => setOpen(true)}
      >
        {showDot && (
          <div
            className="w-2 h-2 rounded-full shrink-0"
            style={{ backgroundColor: connected ? '#4caf50' : '#f44336' }}
          />
        )}
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {connected ? 'Connected' : 'Disconnected'}
        </span>
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="max-h-[70vh]">
          <SheetHeader>
            <SheetTitle>Connection</SheetTitle>
          </SheetHeader>

          <div className="mt-3 flex items-center gap-2 text-sm">
            <div
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: connected ? '#4caf50' : '#f44336' }}
            />
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
