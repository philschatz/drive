import type { ComponentChildren } from 'preact';
import { useWsStatus, getWorkerPeerId } from './automerge';
import { peerColor, peerDisplayName } from './presence';
import { AccessControl } from '../components/AccessControl';
import { useAccess } from './useAccess';
import { getDocEntry } from '../doc-storage';

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
  onToggleValidation,
  validationActive = false,
  validationCount = 0,
  docType,
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
  onToggleValidation?: () => void;
  validationActive?: boolean;
  validationCount?: number;
  /** Document type (Calendar/TaskList/DataGrid) — embedded in invite URL for correct redirect. */
  docType?: string;
  children?: ComponentChildren;
}) {
  const connected = useWsStatus(docId!);
  const encrypted = docId ? !!getDocEntry(docId)?.encrypted : false;
  const { access } = useAccess(encrypted ? docId : undefined);

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
        {/* Peer dots — clipped to ~4 dots on narrow screens */}
        <div className="flex items-center gap-1 max-w-[72px] sm:max-w-none overflow-hidden">
          {peers.filter(p => p.peerId !== getWorkerPeerId()).map(peer => (
            <div
              key={peer.peerId}
              style={{ width: 12, height: 12, borderRadius: '50%', flexShrink: 0, backgroundColor: peerColor(peer.peerId) }}
              title={peerTitle ? peerTitle(peer) : peerDisplayName(peer.peerId)}
            />
          ))}
        </div>

        <span
          className="text-xs text-muted-foreground whitespace-nowrap"
          title={connected ? `Me: ${getWorkerPeerId()}` : 'Disconnected from server'}
        >
          {connected ? 'Connected' : 'Disconnected'}
        </span>

        {/* Sharing / access button */}
        {encrypted && docId && (
          <AccessControl
            docId={docId}
            docType={docType}
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
