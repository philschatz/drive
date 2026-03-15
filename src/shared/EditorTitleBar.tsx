import type { ComponentChildren } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { useWsStatus, getWorkerPeerId } from './automerge';
import { peerColor } from './presence';
import { AccessControl } from '../client/components/AccessControl';
import { enableSharing, registerSharingGroup, registerDocMapping } from './keyhive-api';
import { useAccess } from './useAccess';
import { isSecureAvailable, getDocEntry } from '../client/doc-storage';

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
  khDocId: initialKhDocId,
  docType,
  onSharingEnabled,
  sharingGroupId,
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
  /** Keyhive document ID (base64). When set, shows the share/permissions button. */
  khDocId?: string;
  /** Document type (Calendar/TaskList/DataGrid) — embedded in invite URL for correct redirect. */
  docType?: string;
  /** Called when sharing is first enabled, with the new khDocId and groupId. */
  onSharingEnabled?: (khDocId: string, groupId: string) => void;
  /** Persisted sharing group ID (needed to restore after reload). */
  sharingGroupId?: string;
  children?: ComponentChildren;
}) {
  const connected = useWsStatus(docId);
  const [khDocId, setKhDocId] = useState(initialKhDocId);
  const [enabling, setEnabling] = useState(false);
  const { access } = useAccess(khDocId);

  // Re-register persisted sharing group and doc mapping with the worker on mount
  useEffect(() => {
    if (initialKhDocId) {
      registerSharingGroup(initialKhDocId, sharingGroupId || '').catch(() => {});
      if (docId) registerDocMapping(docId, initialKhDocId);
    }
  }, [initialKhDocId, sharingGroupId, docId]);

  const handleEnableSharing = async () => {
    setEnabling(true);
    try {
      const { khDocId: newId, groupId } = await enableSharing(docId!);
      setKhDocId(newId);
      onSharingEnabled?.(newId, groupId);
    } catch (err: any) {
      console.error('Failed to enable sharing:', err);
    } finally {
      setEnabling(false);
    }
  };

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
        {peers.filter(p => p.peerId !== getWorkerPeerId()).map(peer => (
          <div
            key={peer.peerId}
            style={{ width: 12, height: 12, borderRadius: '50%', flexShrink: 0, backgroundColor: peerColor(peer.peerId) }}
            title={peerTitle ? peerTitle(peer) : `Peer ${peer.peerId}`}
          />
        ))}

        <span
          className="text-xs text-muted-foreground whitespace-nowrap"
          title={connected ? `Me: ${getWorkerPeerId()}` : 'Disconnected from server'}
        >
          {connected ? 'Connected' : 'Disconnected'}
        </span>

        {access && (
          <span
            className="inline-flex items-center justify-center h-9 w-9 rounded-md text-muted-foreground"
            title={`Access: ${access}`}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
              {access === 'admin' ? 'admin_panel_settings' : access === 'write' ? 'edit' : access === 'read' ? 'visibility' : 'download'}
            </span>
          </span>
        )}

        {khDocId && docId ? (
          <AccessControl
            khDocId={khDocId}
            docId={docId}
            docType={docType}
            sharingGroupId={sharingGroupId}
            onGroupIdChange={(gid) => onSharingEnabled?.(khDocId!, gid)}
          />
        ) : isSecureAvailable() && docId && getDocEntry(docId)?.encrypted && (
          <button
            className="inline-flex items-center justify-center h-9 w-9 rounded-md hover:bg-accent hover:text-accent-foreground"
            title="Enable sharing"
            onClick={handleEnableSharing}
            disabled={enabling}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
              {enabling ? 'hourglass_empty' : 'share'}
            </span>
          </button>
        )}

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
