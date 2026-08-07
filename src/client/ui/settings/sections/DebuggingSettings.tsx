/**
 * Debugging — connection diagnostics plus the debug-mode switch and cache
 * clearing. A view for troubleshooting sync from a device with no browser devtools
 * (e.g. the phone PWA).
 *
 * It surfaces the two *distinct* connection signals that are easy to confuse:
 *   - the raw relay WebSocket (useWsStatus) — "are we reachable to the server?"
 *   - the repo peer count (useConnectionStatus/usePeerList) — "are other devices online?"
 * The Home indicator historically read the peer count while labelling it "server",
 * which is why the phone showed "Disconnected" while sync worked. This page keeps
 * the two separate so the real state is unambiguous.
 *
 * Both connection signals stay *inline* rather than becoming snackbars: they are
 * standing conditions, and a notice that auto-dismisses can't report a state.
 */
import { useState, useEffect } from 'preact/hooks';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { MdTextField } from '@/components/ui/md-text-field';
import { showError } from '@/components/ui/toast';
import {
  useWsStatus,
  useConnectionStatus,
  usePeerList,
  usePeerTransports,
  getWorkerPeerId,
  getWorkerUserGroupId,
  getWorkerError,
  onWorkerError,
  setDebugEnabled,
  clearAllCaches,
  onDeviceNamesUpdated,
  useTabRole,
} from '../../worker-api';
import { navigateToUrlOrHash } from '../../common/navigate-url';
import { peerIdentityKey } from '../../common/presence';
import { PeerDot } from '../../common/PeerDot';
import { RenameSheet } from '../../common/RenameSheet';
import { getDeviceName, setDeviceName, resolveDeviceName } from '../../device-names';
import { PRODUCTION_RELAY_URL } from '../../../../shared/relay-identity';
import { isDebugEnabled } from '../../../shared/idb-storage';
import { SettingsGroup, SettingsProse } from '../SettingsGroup';
import { CopyRow } from '../CopyRow';

/** Mirror of the relay URL chosen in automerge-worker.ts (https → prod, else local ws). */
function relayUrl(): string {
  if (typeof location === 'undefined') return PRODUCTION_RELAY_URL;
  return location.protocol === 'https:'
    ? PRODUCTION_RELAY_URL
    : `ws://${location.hostname || 'localhost'}:${location.port || 3000}`;
}

export function DebuggingSettings() {
  // `debugOn` must be settable: md-switch flips its own `selected` on activation, so
  // without a re-render writing it back, a FAILED toggle would leave the thumb in
  // the new position while the setting is unchanged — the error toast contradicting
  // the visible control. (Named `debugOn` to avoid colliding with the imported
  // `setDebugEnabled` worker call.)
  const [debugOn, setDebugOn] = useState(isDebugEnabled());
  const [busy, setBusy] = useState(false);

  const wsConnected = useWsStatus();
  const peerConnected = useConnectionStatus();
  const peers = usePeerList();
  const transports = usePeerTransports();
  const tabRole = useTabRole();

  const [workerError, setWorkerError] = useState<string | null>(() => getWorkerError());
  useEffect(() => onWorkerError(setWorkerError), []);

  // Device names live in a module-level cache that fills in asynchronously (seeded
  // on worker startup, learned at link time), so bump a counter to force the
  // re-render during which getDeviceName is re-read.
  const [, setNamesVersion] = useState(0);
  useEffect(() => onDeviceNamesUpdated(() => setNamesVersion(v => v + 1)), []);

  /**
   * The device being renamed, with the value to seed the field from. Carried
   * together because the seed differs per row: your own device seeds from the
   * generated default it currently displays, a peer from its stored name or nothing
   * (never `resolveDeviceName`, whose fallback is *this* browser's name).
   */
  const [renameFor, setRenameFor] = useState<{ agentId: string; value: string } | null>(null);

  /** The Open-link form's draft. */
  const [linkUrl, setLinkUrl] = useState('');

  // This device's peerId is "<base64 agentId>-drive"; the prefix is the agentId
  // its device name is keyed by (base64 never contains '-', so the split is exact).
  const myPeerId = getWorkerPeerId();
  const myAgentId = myPeerId ? myPeerId.split('-')[0] : '';

  const handleToggleDebug = async () => {
    if (busy) return;
    const next = !debugOn;
    setDebugOn(next); // optimistic: the row shows the new position immediately
    setBusy(true);
    try {
      await setDebugEnabled(next); // persists, tells worker, then reloads the page
    } catch (err: any) {
      setDebugOn(!next);
      showError('Failed to update debug setting: ' + err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleClearCaches = async () => {
    try {
      await clearAllCaches(); // clears caches, then reloads the page
    } catch (err: any) {
      showError('Failed to clear caches: ' + err.message);
    }
  };

  const handleNavigateUrl = () => {
    if (!linkUrl.trim()) return;
    const err = navigateToUrlOrHash(linkUrl);
    if (err) showError(`Invalid URL — ${err.toLowerCase()}`);
  };

  const saveName = (agentId: string, name: string) => {
    setDeviceName(agentId, name).catch((err: any) =>
      showError('Could not save the name: ' + (err?.message ?? 'storage error')));
  };

  return (
    <>
      {/* A crashed worker is a standing condition with an exception to read — a
          banner, not a snackbar. (Notifications.tsx also raises a global persistent
          toast for it; this is the page you land on to read the detail.) */}
      {workerError && (
        <Alert variant="destructive" className="mt-2 mx-4">
          <div className="font-semibold">Document engine error</div>
          <div className="text-sm break-words">{workerError}</div>
        </Alert>
      )}

      {/* Relay server — the raw WebSocket. This is the real "connected to server". */}
      <SettingsGroup label="Relay server">
        <md-list-item type="text" data-testid="relay-status" data-open={String(wsConnected)}>
          <md-icon slot="start" style={wsConnected ? undefined : { color: 'var(--md-sys-color-error)' }}>
            {wsConnected ? 'cloud_done' : 'cloud_off'}
          </md-icon>
          <div slot="headline">Relay socket</div>
          <div slot="supporting-text" style={wsConnected ? undefined : { color: 'var(--md-sys-color-error)' }}>
            {wsConnected ? 'Open' : 'Closed'}
          </div>
        </md-list-item>
        <CopyRow icon="link" label="Relay URL" value={relayUrl()} data-testid="relay-url" />
      </SettingsGroup>
      <SettingsProse>
        Edits are always saved on this device and sync to your other devices and friends
        once one is online. The relay only routes changes between devices — it never stores them.
      </SettingsProse>

      {/* This device */}
      <SettingsGroup label="This device">
        <md-list-item
          type={myAgentId ? 'button' : 'text'}
          data-testid="my-device-name"
          onClick={myAgentId
            // Seeds from the generated default this row displays, so you edit
            // "💻 Chrome" rather than typing from nothing.
            ? () => setRenameFor({ agentId: myAgentId, value: resolveDeviceName(myAgentId) ?? '' })
            : undefined}
        >
          <md-icon slot="start">smartphone</md-icon>
          <div slot="headline">Name</div>
          <div slot="supporting-text" className={myAgentId ? undefined : 'opacity-60'}>
            {myAgentId ? resolveDeviceName(myAgentId) : '(not ready)'}
          </div>
          {myAgentId && <md-icon slot="end" aria-hidden="true">edit</md-icon>}
        </md-list-item>
        <CopyRow icon="fingerprint" label="Peer ID" value={myPeerId} empty="(not ready)" data-testid="my-peer-id" />
        <CopyRow icon="group" label="User group" value={getWorkerUserGroupId()} empty="(none)" data-testid="my-user-group" />
        {/* Which tab owns the device's single engine. Both roles edit and sync the
            same; this only explains where the work is actually happening. */}
        <md-list-item type="text" data-testid="tab-role">
          <md-icon slot="start">tab_group</md-icon>
          <div slot="headline">Engine</div>
          <div slot="supporting-text">
            {tabRole === 'leader'
              ? 'This tab (other tabs route through it)'
              : tabRole === 'follower'
                ? 'Another tab (this one routes through it)'
                : 'Starting…'}
          </div>
        </md-list-item>
      </SettingsGroup>

      {/* Peers — other devices/friends. NOT the server. */}
      <SettingsGroup label={`Peer devices (${peers.length})`}>
        {peers.length === 0 ? (
          <md-list-item type="text" data-testid="no-peers">
            <div slot="headline" className="opacity-60">No peers.</div>
          </md-list-item>
        ) : (
          peers.map(peerId => {
            // peerId is "<base64 agentId>-drive"; the prefix is the device agentId.
            const agentId = peerId.split('-')[0];
            // NOT resolveDeviceName: its fallback is generateDefaultDeviceName(),
            // i.e. *this* browser's name, which would mislabel every unnamed peer.
            const name = getDeviceName(agentId);
            return (
              <md-list-item
                key={peerId}
                type="button"
                data-testid="peer-row"
                title={peerId}
                onClick={() => setRenameFor({ agentId, value: name ?? '' })}
              >
                <span slot="start" className="inline-flex items-center justify-center w-6">
                  <PeerDot
                    identityKey={peerIdentityKey(peerId)}
                    direct={transports[peerId] === 'direct'}
                    label={name || agentId}
                    sizeClass="w-2.5 h-2.5"
                  />
                </span>
                <div slot="headline" className={name ? undefined : 'text-muted-foreground'}>
                  {name || `${agentId.slice(0, 16)}…`}
                </div>
                <div slot="supporting-text" className="font-mono truncate">{peerId}</div>
                <div slot="trailing-supporting-text">
                  {transports[peerId] === 'direct' ? 'direct (P2P)' : 'via relay'}
                </div>
              </md-list-item>
            );
          })
        )}
      </SettingsGroup>
      <SettingsProse>
        Other devices/friends currently reachable.{' '}
        {peerConnected ? 'At least one peer is online.' : 'No peers online right now.'}
      </SettingsProse>

      {/* Maintenance */}
      <SettingsGroup label="Maintenance">
        <md-list-item
          type="button"
          data-testid="debug-toggle"
          data-selected={String(debugOn)}
          disabled={busy || undefined}
          onClick={handleToggleDebug}
        >
          <md-icon slot="start">bug_report</md-icon>
          <div slot="headline">Enable debugging</div>
          <div slot="supporting-text">
            Bypasses all caches and logs every keyhive/WASM call. The page reloads when this changes.
          </div>
          {/* Visual + AT state only — the row owns the interaction, giving a full-row
              target and no double-fire from the switch's own change event.
              `selected` (not `checked`) is md-switch's property, and it must be a
              real boolean: Preact skips writing for null/undefined, so
              `debugOn || undefined` could never turn it off. */}
          <md-switch slot="end" selected={debugOn} tabIndex={-1} className="pointer-events-none" />
        </md-list-item>
        {/* Neutral tone and no confirm: nothing is lost by dropping a cache. */}
        <md-list-item type="button" data-testid="clear-caches" onClick={handleClearCaches}>
          <md-icon slot="start">cleaning_services</md-icon>
          <div slot="headline">Clear caches</div>
          <div slot="supporting-text">Reloads the app</div>
        </md-list-item>
      </SettingsGroup>

      {/* Open link — a developer utility, folded in from its own former Settings
          row. Last, and a real form rather than a list row, because unlike
          everything above it there is something to submit. */}
      <div className="md-label-large text-on-surface-variant mt-4 mb-1 px-4">Open link</div>
      <SettingsProse>
        Paste a link to navigate to it (e.g. document or add-friend links).
      </SettingsProse>
      <div className="px-4 pt-2">
        <MdTextField
          label="Link"
          type="url"
          value={linkUrl}
          placeholder="https://… or #/…"
          data-testid="developer-url"
          onInput={setLinkUrl}
          onEnter={handleNavigateUrl}
        />
        <div className="flex items-center justify-end gap-2 mt-4">
          <Button data-testid="developer-go" disabled={!linkUrl.trim()} onClick={handleNavigateUrl}>
            Open
          </Button>
        </div>
      </div>

      <RenameSheet
        open={!!renameFor}
        title="Rename device"
        label="Device name"
        value={renameFor?.value ?? ''}
        onRename={name => renameFor && saveName(renameFor.agentId, name)}
        onClose={() => setRenameFor(null)}
        data-testid="device-rename-sheet"
      />
    </>
  );
}
