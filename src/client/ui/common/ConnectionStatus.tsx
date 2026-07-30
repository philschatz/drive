import { useState } from 'preact/hooks';
import { useWsStatus, usePeerTransports, getWorkerPeerId } from './automerge';
import { getWorkerUserGroupId } from '../worker-api';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { dedupePeers, peerDisplayName, peerIdentityKey, type PresenceState } from './presence';
import { PeerDot } from './PeerDot';

interface PeerLike {
  peerId: string;
  value?: PresenceState | null;
}

/**
 * Relay connection status indicator. Tapping it opens a bottom sheet listing the
 * peers on this document and whether each is connected directly (P2P) or via the
 * relay. (The fuller connection-debug page is at `#/settings/debugging`.)
 *
 * Reused by Home and the DocumentTitleBar.
 *
 * The sheet deliberately mirrors the Debugging page's relay and peer rows — same
 * `cloud_done`/`cloud_off` glyph, same "Relay socket / Open|Closed", same
 * "direct (P2P)"/"via relay" wording — because the two surfaces report the same
 * two facts and used to describe them differently. Note the transport vocabulary
 * splits by whether a row can be *offline*: live-peer lists (here, Debugging) name
 * the transport, while member/device rows use the tri-state P2P / Via relay /
 * Offline.
 */
export function ConnectionStatus<P extends PeerLike>({
  className = '',
  peers = [],
  peerTitle,
}: {
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
      {/* One button: peer dots + status icon — tapping either opens the sheet.
          (The text label was pure noise on a narrow bar; the accessible name
          still reads "Connected"/"Disconnected".)

          Disconnected from the relay there are no peers and no transports to
          report, so the button is disabled (dimmed to the MD3 38% disabled
          opacity) rather than recoloured — the greyed-out control is the
          offline signal. */}
      {/* Stays a real <button>: the title-bar tests read `.disabled`, which an
          md-icon-button host would report as undefined under jsdom. */}
      <button
        aria-label={connected ? 'Connected' : 'Disconnected'}
        disabled={!connected}
        className={
          'inline-flex items-center gap-2 h-10 px-1.5 rounded-full shrink-0 ' +
          (connected ? 'cursor-pointer state-layer ' : 'cursor-default opacity-[0.38] ') +
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
            the button's gap doesn't leave a hole before the icon.)

            These must keep rendering here, on the CLOSED page: four Playwright
            presence specs and the docs capture count `[data-testid="peer-dot"]` to
            tell that two peers have found each other. */}
        {visible.length > 0 && (
          <div className="flex items-center gap-1 max-w-[72px] sm:max-w-none overflow-hidden">
            {visible.map(peer => (
              <PeerDot
                key={peerIdentityKey(peer.peerId, peer.value?.userGroupId)}
                identityKey={peerIdentityKey(peer.peerId, peer.value?.userGroupId)}
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
          {connected ? 'cloud_done' : 'cloud_off'}
        </span>
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="max-h-[70vh] p-4 overflow-y-auto">
          {/* SheetContent doesn't forward extra props — testid goes on a wrapper */}
          <div data-testid="connection-sheet">
            <SheetHeader>
              <SheetTitle className="pr-8">Connection</SheetTitle>
            </SheetHeader>

            {/* Same shape as the Debugging page's relay row, down to the glyph. */}
            <md-list style={{ background: 'transparent' }} className="mt-2">
              <md-list-item type="text" data-testid="relay-status" data-open={String(connected)}>
                <md-icon slot="start" style={connected ? undefined : { color: 'var(--md-sys-color-error)' }}>
                  {connected ? 'cloud_done' : 'cloud_off'}
                </md-icon>
                <div slot="headline">Relay socket</div>
                <div slot="supporting-text" style={connected ? undefined : { color: 'var(--md-sys-color-error)' }}>
                  {connected ? 'Open' : 'Closed'}
                </div>
              </md-list-item>
            </md-list>

            {/* Inlined rather than importing settings/SettingsGroup — common/
                reaching into settings/ would be backwards for two lines of markup. */}
            <div className="md-label-large text-on-surface-variant mt-4 mb-1 px-4">
              Peers on this document
            </div>
            <md-list style={{ background: 'transparent' }}>
              {visible.length === 0 ? (
                <md-list-item type="text" data-testid="no-connection-peers">
                  <div slot="headline" className="opacity-60">No one else is here right now.</div>
                </md-list-item>
              ) : (
                visible.map(peer => {
                  const direct = transports[peer.peerId] === 'direct';
                  const name = peerTitle
                    ? peerTitle(peer)
                    : peerDisplayName(peer.peerId, peer.value?.userGroupId);
                  return (
                    <md-list-item
                      key={peer.peerId}
                      type="text"
                      data-testid="connection-peer-row"
                      title={peer.peerId}
                    >
                      <span slot="start" className="inline-flex items-center justify-center w-6">
                        <PeerDot
                          identityKey={peerIdentityKey(peer.peerId, peer.value?.userGroupId)}
                          direct={direct}
                          label={name}
                          sizeClass="w-2.5 h-2.5"
                        />
                      </span>
                      <div slot="headline">{name}</div>
                      <div slot="trailing-supporting-text">
                        {direct ? 'direct (P2P)' : 'via relay'}
                      </div>
                    </md-list-item>
                  );
                })
              )}
            </md-list>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
