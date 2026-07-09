import type { ReactNode } from 'react';
import { useWsStatus, usePeerTransports, getWorkerPeerId } from './automerge';
import { getWorkerUserGroupId } from '../worker-api';
import { peerDisplayName, peerIdentityKey, PeerDot, type PresenceState } from './presence';
import { AccessControl } from '../components/AccessControl';
import { useAccess } from './useAccess';

interface PeerLike {
  peerId: string;
  /** Decrypted presence value, if any — carries the peer's user-group id. */
  value?: PresenceState | null;
}

export function EditorTitleBar<P extends PeerLike>({
  icon,
  title,
  titleEditable = false,
  onTitleChange,
  onTitleBlur,
  onTitleFocus,
  docId,
  peers = [],
  peerTitle,
  showSourceLink = true,
  sourcePath,
  onToggleHistory,
  historyActive = false,
  onToggleValidation,
  validationActive = false,
  validationCount = 0,
  children,
}: {
  icon: string;
  title: string;
  titleEditable?: boolean;
  onTitleChange?: (value: string) => void;
  onTitleBlur?: (value: string) => void;
  onTitleFocus?: () => void;
  docId?: string;
  peers?: P[];
  peerTitle?: (peer: P) => string;
  showSourceLink?: boolean;
  /** Automerge path to the currently focused node — appended to Edit Source URL. */
  sourcePath?: (string | number)[];
  onToggleHistory?: () => void;
  historyActive?: boolean;
  onToggleValidation?: () => void;
  validationActive?: boolean;
  validationCount?: number;
  children?: ReactNode;
}) {
  const connected = useWsStatus(docId!);
  const transports = usePeerTransports();
  const { access } = useAccess(docId);

  return (
    <div className="flex items-center gap-1.5 px-1 min-h-10 w-full">
      {/* Left side */}
      <a
        href="#/"
        className="inline-flex items-center justify-center h-9 w-9 rounded-md hover:bg-accent hover:text-accent-foreground shrink-0"
      >
        <span className="material-symbols-outlined">arrow_back</span>
      </a>

      <span className="material-symbols-outlined text-muted-foreground shrink-0" style={{ fontSize: 20 }}>
        {icon}
      </span>

      {titleEditable ? (
        <input
          className="border-0 bg-transparent text-lg font-bold outline-none flex-1 min-w-0"
          value={title}
          onFocus={() => onTitleFocus?.()}
          onInput={(e: any) => onTitleChange?.(e.currentTarget.value)}
          onBlur={(e: any) => onTitleBlur?.(e.currentTarget.value)}
          onKeyDown={(e: any) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        />
      ) : (
        <span className="text-lg font-bold truncate">{title}</span>
      )}

      {access === 'read' && (
        <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded shrink-0">Read-only</span>
      )}

      {children}

      {/* Right side */}
      <div className="flex items-center gap-1 sm:gap-1.5 ml-auto shrink-0">
        {/* Peer dots — clipped to ~4 dots on narrow screens. Devices of the same user
            collapse to a single dot (keyed by user-group id); all of the local user's
            own devices are hidden, not just the current one. */}
        <div className="flex items-center gap-1 max-w-[72px] sm:max-w-none overflow-hidden">
          {(() => {
            const myPeerId = getWorkerPeerId();
            const myGroup = getWorkerUserGroupId();
            const seen = new Set<string>();
            return peers.filter(peer => {
              if (peer.peerId === myPeerId) return false;
              const ug = peer.value?.userGroupId;
              if (myGroup && ug === myGroup) return false; // another of my own devices
              const id = peerIdentityKey(peer.peerId, ug);
              if (seen.has(id)) return false; // collapse a user's devices to one dot
              seen.add(id);
              return true;
            }).map(peer => (
              <PeerDot
                key={peerIdentityKey(peer.peerId, peer.value?.userGroupId)}
                peerId={peer.peerId}
                userGroupId={peer.value?.userGroupId}
                direct={transports[peer.peerId] === 'direct'}
                label={peerTitle ? peerTitle(peer) : peerDisplayName(peer.peerId, peer.value?.userGroupId)}
                sizeClass="w-3 h-3"
              />
            ));
          })()}
        </div>

        <span
          className="text-xs text-muted-foreground whitespace-nowrap"
          title={connected ? `Me: ${getWorkerPeerId()}` : 'Disconnected from server'}
        >
          {connected ? 'Connected' : 'Disconnected'}
        </span>

        {/* Sharing / access button */}
        {docId && (
          <AccessControl
            docId={docId}
            access={access}
          />
        )}

        {/* History & source — inline on sm+, collapsed into dropdown on mobile */}
        {onToggleValidation && validationCount! > 0 && (
          <button
            className={`inline-flex items-center justify-center h-9 rounded-md hover:bg-accent hover:text-accent-foreground gap-0.5 px-1.5${validationActive ? ' bg-accent text-accent-foreground' : ''}`}
            onClick={onToggleValidation}
            title={validationActive ? 'Hide validation errors' : `${validationCount} validation error${validationCount !== 1 ? 's' : ''}`}
          >
            <span className="material-symbols-outlined text-amber-500" style={{ fontSize: 18 }}>warning</span>
            <span className="text-xs text-amber-600 font-medium">{validationCount! > 99 ? '99+' : validationCount}</span>
          </button>
        )}

        {onToggleHistory && (
          <button
            className={`inline-flex items-center justify-center h-9 w-9 rounded-md hover:bg-accent hover:text-accent-foreground${historyActive ? ' bg-accent text-accent-foreground' : ''}`}
            onClick={onToggleHistory}
            title={historyActive ? 'Close history' : 'Browse history'}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>history</span>
          </button>
        )}

        {showSourceLink && docId && (
          <a
            href={`#/source/${docId}${sourcePath?.length ? '/' + sourcePath.map(s => encodeURIComponent(String(s))).join('/') : ''}`}
            className="inline-flex items-center justify-center h-9 w-9 rounded-md hover:bg-accent hover:text-accent-foreground"
            title="Edit Source"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>code</span>
          </a>
        )}

      </div>
    </div>
  );
}
