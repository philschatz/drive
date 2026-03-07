import type { ComponentChildren } from 'preact';
import { useConnectionStatus, repo } from './automerge';
import { peerColor } from './presence';

interface PeerLike {
  peerId: string;
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
  onToggleHistory,
  historyActive = false,
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
  onToggleHistory?: () => void;
  historyActive?: boolean;
  children?: ComponentChildren;
}) {
  const connected = useConnectionStatus();

  return (
    <div className="flex items-center gap-1.5 px-1 min-h-10 max-w-screen-xl mx-auto w-full">
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

      {children}

      {/* Right side */}
      <div className="flex items-center gap-1.5 ml-auto shrink-0">
        {peers.filter(p => p.peerId !== repo.peerId).map(peer => (
          <div
            key={peer.peerId}
            style={{ width: 12, height: 12, borderRadius: '50%', flexShrink: 0, backgroundColor: peerColor(peer.peerId) }}
            title={peerTitle ? peerTitle(peer) : `Peer ${peer.peerId}`}
          />
        ))}

        <span
          className="text-xs text-muted-foreground whitespace-nowrap"
          title={connected ? `Me: ${repo.peerId}` : 'Disconnected from server'}
        >
          {connected ? 'Connected' : 'Disconnected'}
        </span>

        {onToggleHistory && (
          <button
            className={`inline-flex items-center justify-center h-9 w-9 rounded-md hover:bg-accent hover:text-accent-foreground ${historyActive ? 'bg-accent text-accent-foreground' : ''}`}
            onClick={onToggleHistory}
            title={historyActive ? 'Close history' : 'Browse history'}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>history</span>
          </button>
        )}

        {showSourceLink && docId && (
          <a
            href={`#/source/${docId}`}
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
