/**
 * Debugging — connection diagnostics plus the debug-mode switch and cache
 * clearing. A read-only-ish view for troubleshooting sync from a device with no
 * browser devtools (e.g. the phone PWA).
 *
 * It surfaces the two *distinct* connection signals that are easy to confuse:
 *   - the raw relay WebSocket (useWsStatus) — "are we reachable to the server?"
 *   - the repo peer count (useConnectionStatus/usePeerList) — "are other devices online?"
 * The Home indicator historically read the peer count while labelling it "server",
 * which is why the phone showed "Disconnected" while sync worked. This page keeps
 * the two separate so the real state is unambiguous.
 */
import { useState, useEffect } from 'preact/hooks';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
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
} from '../../worker-api';
import { PeerDot } from '../../common/presence';
import { EditableDeviceName } from '@/components/EditableDeviceName';
import { PRODUCTION_RELAY_URL } from '../../../../shared/relay-identity';
import { isDebugEnabled } from '../../../shared/idb-storage';
import { useSectionAlerts } from '../SettingsSubScreen';

/** Mirror of the relay URL chosen in automerge-worker.ts (https → prod, else local ws). */
function relayUrl(): string {
  if (typeof location === 'undefined') return PRODUCTION_RELAY_URL;
  return location.protocol === 'https:'
    ? PRODUCTION_RELAY_URL
    : `ws://${location.hostname || 'localhost'}:${location.port || 3000}`;
}

export function DebuggingSettings() {
  const { alerts, setError } = useSectionAlerts();
  const [debugEnabled] = useState(isDebugEnabled());

  const wsConnected = useWsStatus();
  const peerConnected = useConnectionStatus();
  const peers = usePeerList();
  const transports = usePeerTransports();

  const [workerError, setWorkerError] = useState<string | null>(() => getWorkerError());
  useEffect(() => onWorkerError(setWorkerError), []);

  // This device's peerId is "<base64 agentId>-drive"; the prefix is the agentId
  // its device name is keyed by (base64 never contains '-', so the split is exact).
  const myPeerId = getWorkerPeerId();
  const myAgentId = myPeerId ? myPeerId.split('-')[0] : '';

  const handleToggleDebug = async (v: boolean) => {
    try {
      await setDebugEnabled(v); // persists, tells worker, then reloads the page
    } catch (err: any) {
      setError('Failed to update debug setting: ' + err.message);
    }
  };

  const handleClearCaches = async () => {
    try {
      await clearAllCaches(); // clears caches, then reloads the page
    } catch (err: any) {
      setError('Failed to clear caches: ' + err.message);
    }
  };

  return (
    <>
      {alerts}

      {workerError && (
        <Alert variant="destructive" className="mb-4">
          <div className="font-semibold">Document engine error</div>
          <div className="text-sm break-words">{workerError}</div>
        </Alert>
      )}

      {/* Relay server — the raw WebSocket. This is the real "connected to server". */}
      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">Relay server</h2>
        <Alert variant={wsConnected ? 'success' : 'destructive'} className="mb-2">
          <span className="font-semibold">
            Relay socket: {wsConnected ? 'open' : 'closed'}
          </span>
        </Alert>
        <dl className="text-sm grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">URL</dt>
          <dd className="font-mono break-all">{relayUrl()}</dd>
        </dl>
        <p className="text-xs text-muted-foreground mt-2">
          Edits are always saved on this device and sync to your other devices and friends
          once one is online. The relay only routes changes between devices — it never stores them.
        </p>
      </section>

      {/* This device */}
      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">This device</h2>
        <dl className="text-sm grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center">
          <dt className="text-muted-foreground">Name</dt>
          <dd>
            {/* peerId is "<base64 agentId>-drive"; base64 has no '-', so the
                prefix is the device agentId this name is keyed by. */}
            {myAgentId
              ? <EditableDeviceName agentId={myAgentId} isMe />
              : <span className="text-muted-foreground">(not ready)</span>}
          </dd>
          <dt className="text-muted-foreground">Peer ID</dt>
          <dd className="font-mono break-all">{myPeerId || '(not ready)'}</dd>
          <dt className="text-muted-foreground">User group</dt>
          <dd className="font-mono break-all">{getWorkerUserGroupId() || '(none)'}</dd>
        </dl>
      </section>

      {/* Peers — other devices/friends. NOT the server. */}
      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">
          Peer devices connected: {peers.length}
        </h2>
        <p className="text-xs text-muted-foreground mb-2">
          Other devices/friends currently reachable. {peerConnected ? 'At least one peer is online.' : 'No peers online right now.'}
        </p>
        {peers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No peers.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {peers.map((peerId) => (
              <li key={peerId} className="flex items-center gap-2 text-sm">
                <PeerDot peerId={peerId} direct={transports[peerId] === 'direct'} />
                {/* peerId is "<base64 agentId>-drive"; the prefix is the device
                    agentId. The device name is editable here too (a name for a
                    peer we didn't learn at link time is a local label). */}
                <EditableDeviceName agentId={peerId.split('-')[0]} />
                <span className="text-xs text-muted-foreground shrink-0">
                  {transports[peerId] === 'direct' ? 'direct (P2P)' : 'via relay'}
                </span>
                <span className="font-mono text-[10px] text-muted-foreground break-all shrink-0 max-w-[35%] truncate">
                  {peerId}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Maintenance */}
      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">Maintenance</h2>
        <p className="text-xs text-muted-foreground mb-2">
          Enabling debug mode bypasses all caches (always reading live data) and logs every
          keyhive/WASM call to the console — and names the last calls on the crash banner if the
          document engine traps. The page reloads when you change this.
        </p>
        <div className="flex items-center gap-2 mb-3">
          <Switch
            id="debug-mode"
            checked={debugEnabled}
            onCheckedChange={handleToggleDebug}
          />
          <Label htmlFor="debug-mode" className="cursor-pointer">Enable debugging (and disable cache)</Label>
        </div>
        <Button size="sm" variant="destructive" onClick={handleClearCaches}>Clear Caches</Button>
      </section>
    </>
  );
}
