import type { ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { usePeerTransports, getWorkerPeerId } from './automerge';
import { ConnectionStatus } from './ConnectionStatus';
import { getWorkerUserGroupId } from '../worker-api';
import { dedupePeers, peerDisplayName, peerIdentityKey, PeerDot, type PresenceState } from './presence';
import { AccessControlSheet } from '../components/AccessControl';
import { useAccess } from './useAccess';
import { sourceUrl } from './doc-urls';
import { OverflowMenu, type OverflowMenuItem } from './OverflowMenu';

interface PeerLike {
  peerId: string;
  /** Decrypted presence value, if any — carries the peer's user-group id. */
  value?: PresenceState | null;
}

/** Extra action contributed by an editor to the overflow (kebab) menu. */
export interface OverflowItem {
  /** Material Symbols icon name. */
  icon: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

/**
 * Material top app bar shared by all document editors: back button, type icon,
 * (editable) title, live presence/connection cluster, and a trailing overflow
 * menu holding the low-frequency actions (Rename / Share / History / Validation
 * / Edit source + editor-specific `overflow` items).
 */
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
  onUndo,
  onToggleValidation,
  validationActive = false,
  validationCount = 0,
  overflow = [],
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
  /** Undo the latest change (shown as an overflow item when provided). */
  onUndo?: () => void;
  onToggleValidation?: () => void;
  validationActive?: boolean;
  validationCount?: number;
  /** Editor-specific extra overflow-menu actions (e.g. "Delete completed"). */
  overflow?: OverflowItem[];
  children?: ComponentChildren;
}) {
  const transports = usePeerTransports();
  const { access } = useAccess(docId);
  const [shareOpen, setShareOpen] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);

  // Assemble the overflow entries. `title` mirrors the old inline-button
  // tooltips (also keeps existing tests/locators working).
  const menuItems: OverflowMenuItem[] = [];
  if (titleEditable) {
    menuItems.push({
      icon: 'edit',
      label: 'Rename',
      title: 'Rename',
      onSelect: () => {
        const next = prompt('Rename', title);
        if (next === null) return;
        const trimmed = next.trim();
        if (!trimmed) return;
        // Commit through the same path as the inline title input.
        onTitleChange?.(trimmed);
        onTitleBlur?.(trimmed);
      },
    });
  }
  // Admins get a dedicated share button on the bar (they manage sharing);
  // everyone else reaches the members list via the overflow menu.
  const isAdmin = access === 'admin';
  if (docId && !isAdmin) {
    menuItems.push({
      icon: 'share',
      label: 'Share',
      title: 'Share & permissions',
      onSelect: () => setShareOpen(true),
    });
  }
  if (onUndo) {
    menuItems.push({
      icon: 'undo',
      label: 'Undo',
      title: 'Undo',
      onSelect: onUndo,
    });
  }
  if (onToggleHistory) {
    menuItems.push({
      icon: 'history',
      label: historyActive ? 'Close history' : 'History',
      title: historyActive ? 'Close history' : 'Browse history',
      onSelect: onToggleHistory,
    });
  }
  if (onToggleValidation && validationCount! > 0) {
    menuItems.push({
      icon: 'warning',
      label: `${validationActive ? 'Hide' : 'Show'} validation errors (${validationCount! > 99 ? '99+' : validationCount})`,
      title: validationActive ? 'Hide validation errors' : `${validationCount} validation error${validationCount !== 1 ? 's' : ''}`,
      onSelect: onToggleValidation,
    });
  }
  menuItems.push(...overflow.map(item => ({ ...item, title: item.label })));
  if (showSourceLink && docId) {
    menuItems.push({
      icon: 'code',
      label: 'Edit source',
      title: 'Edit Source',
      href: sourceUrl(docId, sourcePath),
      // Separate the navigation away from the in-place actions above it.
      dividerBefore: menuItems.length > 0,
    });
  }

  return (
    <div className="flex items-center gap-1.5 pl-1 pr-2 min-h-14 w-full">
      {/* Left side */}
      <a
        href="#/"
        aria-label="Back"
        className="inline-flex items-center justify-center h-10 w-10 rounded-full state-layer shrink-0"
      >
        <span className="material-symbols-outlined" style={{ fontSize: 24 }}>arrow_back</span>
      </a>

      <span className="material-symbols-outlined text-muted-foreground shrink-0" style={{ fontSize: 20 }}>
        {icon}
      </span>

      {titleEditable ? (
        <input
          ref={titleInputRef}
          data-testid="doc-title-input"
          className="border-0 bg-transparent md-title-large font-bold outline-none flex-1 min-w-0"
          value={title}
          onFocus={() => onTitleFocus?.()}
          onInput={(e: any) => onTitleChange?.(e.currentTarget.value)}
          onBlur={(e: any) => onTitleBlur?.(e.currentTarget.value)}
          onKeyDown={(e: any) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        />
      ) : (
        <span className="md-title-large font-bold truncate flex-1 min-w-0">{title}</span>
      )}

      {children}

      {/* Right side */}
      <div className="flex items-center gap-1 sm:gap-1.5 ml-auto shrink-0">
        {/* Peer dots — clipped to ~4 dots on narrow screens. Devices of the same user
            collapse to a single dot (keyed by user-group id); all of the local user's
            own devices are hidden, not just the current one. */}
        <div className="flex items-center gap-1 max-w-[72px] sm:max-w-none overflow-hidden">
          {dedupePeers(peers, getWorkerPeerId(), getWorkerUserGroupId()).map(peer => (
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

        <ConnectionStatus peers={peers} peerTitle={peerTitle} />

        {/* Admins manage sharing, so they get the share button right on the
            bar; other access levels find Share in the overflow menu. */}
        {docId && isAdmin && (
          <button
            aria-label="Share"
            title="Share & permissions"
            className="inline-flex items-center justify-center h-10 w-10 rounded-full state-layer shrink-0"
            onClick={() => setShareOpen(true)}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 20 }}>share</span>
          </button>
        )}

        {/* Overflow (kebab) menu — Rename / Share / History / Validation /
            editor-specific items / Edit source. */}
        <OverflowMenu items={menuItems} />
      </div>

      {/* Share & Permissions sheet — opened from the overflow menu. */}
      {docId && (
        <AccessControlSheet
          docId={docId}
          access={access}
          open={shareOpen}
          onOpenChange={setShareOpen}
        />
      )}
    </div>
  );
}
