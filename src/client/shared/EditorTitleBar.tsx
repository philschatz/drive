import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { usePeerTransports, getWorkerPeerId } from './automerge';
import { ConnectionStatus } from './ConnectionStatus';
import { getWorkerUserGroupId } from '../worker-api';
import { dedupePeers, peerDisplayName, peerIdentityKey, PeerDot, type PresenceState } from './presence';
import { AccessControlSheet } from '../components/AccessControl';
import { useAccess } from './useAccess';
import { sourceUrl } from './doc-urls';
import { OverflowMenu, type OverflowMenuItem } from './OverflowMenu';
import { MATERIAL_ORANGE } from './categorical-colors';

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

/** Document-specific button placed directly on the bar (after undo/redo). */
export interface BarAction extends OverflowItem {
  /** Render in the selected/toggled state. */
  active?: boolean;
  /** Optional colour role for the icon (e.g. 'error' for validation). */
  tone?: 'error';
  /** Long-press (or right-click) alternative — e.g. undo → browse history. */
  onLongPress?: () => void;
}

/**
 * Circular 40px icon button matching the app bar's metrics. `onLongPress`
 * adds a secondary gesture (hold on touch, right-click with a mouse).
 */
export function BarIconButton({
  icon,
  label,
  onClick,
  onLongPress,
  disabled,
  active,
  tone,
  size = 22,
}: {
  icon: string;
  label: string;
  onClick?: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  active?: boolean;
  tone?: 'error';
  size?: number;
}) {
  const pressRef = useRef<{ timer: number; fired: boolean } | null>(null);
  const longPress = onLongPress && !disabled
    ? {
      onPointerDown: (e: any) => {
        if (e.pointerType === 'mouse') return; // mouse uses right-click below
        const timer = window.setTimeout(() => {
          if (pressRef.current) pressRef.current.fired = true;
          onLongPress();
        }, 450);
        pressRef.current = { timer, fired: false };
      },
      onPointerUp: () => {
        if (pressRef.current) clearTimeout(pressRef.current.timer);
      },
      onPointerCancel: () => {
        if (pressRef.current) clearTimeout(pressRef.current.timer);
        pressRef.current = null;
      },
      onContextMenu: (e: any) => { e.preventDefault(); onLongPress(); },
    }
    : {};

  return (
    <button
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => {
        // Swallow the click that follows a long-press.
        if (pressRef.current?.fired) { pressRef.current = null; return; }
        onClick?.();
      }}
      {...longPress}
      className={
        'inline-flex items-center justify-center h-10 w-10 rounded-full state-layer shrink-0 disabled:opacity-30' +
        (active ? ' bg-secondary-container text-on-secondary-container' : '') +
        (tone === 'error' ? ' text-error' : '')
      }
    >
      <span className="material-symbols-outlined" style={{ fontSize: size }}>{icon}</span>
    </button>
  );
}

/**
 * Material top app bar shared by all document editors: back button, type icon,
 * (editable) title, undo/redo, live presence/connection cluster, and a trailing
 * overflow menu holding the low-frequency actions (Rename / Share / History /
 * Validation / Edit source + editor-specific `overflow` items).
 *
 * The bar is sticky and hides itself when `hidden` is set — editors get that
 * from the shared `useHideOnScroll()` hook, so dragging up hides the chrome and
 * dragging back down reveals it in every document type.
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
  onRedo,
  canUndo,
  canRedo,
  hasValidationErrors = false,
  action,
  overflow = [],
  historyPlacement = 'menu',
  hidden = false,
  sticky = true,
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
  /** Undo the latest change — rendered as a bar button (with redo). */
  onUndo?: () => void;
  /** Redo the change undone last. */
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  /** Show the warning button linking to the source editor. */
  hasValidationErrors?: boolean;
  /** The document's own bar button, shown right after undo/redo. */
  action?: BarAction;
  /** Document-specific items shown behind the kebab. */
  overflow?: OverflowItem[];
  /** Put History on the bar (as a document action) instead of in the kebab. */
  historyPlacement?: 'menu' | 'bar';
  /** Slide the bar out of view (see useHideOnScroll). */
  hidden?: boolean;
  /** Set false when the bar sits in a fixed-height flex layout that positions
   * it itself (DataGrid), rather than over scrolling page content. */
  sticky?: boolean;
  children?: ComponentChildren;
}) {
  const transports = usePeerTransports();
  const { access } = useAccess(docId);
  const [shareOpen, setShareOpen] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);

  // Bar layout is declared, not measured: undo/redo first, then the document's
  // own actions, then the connection/share cluster, validation, and the kebab.
  // Each editor decides what belongs on the bar (`actions`) and what belongs
  // behind the kebab (`overflow`).
  const isAdmin = access === 'admin';

  const historyItem = onToggleHistory && {
    icon: 'history',
    label: 'History',
    title: 'History',
    onSelect: onToggleHistory,
  };

  // Kebab: rename, sharing (non-admins), history (unless the editor pulls it
  // onto the bar), the editor's own overflow items, then Edit source.
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
  // everyone else reaches the read-only members list via the overflow menu —
  // labelled "Sharing" since non-admins can view permissions but not share.
  if (docId && !isAdmin) {
    menuItems.push({
      icon: 'share',
      label: 'Sharing',
      title: 'Share & permissions',
      onSelect: () => setShareOpen(true),
    });
  }
  if (historyItem && historyPlacement === 'menu') menuItems.push(historyItem);
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
    <div
      className={
        'flex items-center gap-1 pl-1 pr-1 min-h-14 w-full bg-surface transition-transform duration-200' +
        (sticky ? ' sticky top-0 z-20' : '') +
        (hidden ? ' -translate-y-full' : '')
      }
    >
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
          className="border-0 bg-transparent md-title-large font-bold outline-none flex-1 min-w-12"
          value={title}
          onFocus={() => onTitleFocus?.()}
          onInput={(e: any) => onTitleChange?.(e.currentTarget.value)}
          onBlur={(e: any) => onTitleBlur?.(e.currentTarget.value)}
          onKeyDown={(e: any) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        />
      ) : (
        <span className="md-title-large font-bold truncate flex-1 min-w-12">{title}</span>
      )}

      {children}

      {/* Right side, in a fixed order: undo/redo, the document's own actions,
          peers + connection, share, validation, kebab. */}
      <div className="flex items-center gap-0.5 sm:gap-1.5 ml-auto shrink-0">
        {/* Undo/redo — long-press (or right-click) browses the version history,
            which is the same restore mechanism they drive. */}
        {onUndo && (
          <BarIconButton
            icon="undo"
            label="Undo"
            onClick={onUndo}
            onLongPress={onToggleHistory}
            disabled={canUndo === false}
          />
        )}
        {onRedo && (
          <BarIconButton
            icon="redo"
            label="Redo"
            onClick={onRedo}
            onLongPress={onToggleHistory}
            disabled={canRedo === false}
          />
        )}

        {/* The document's own action */}
        {action && (
          <BarIconButton
            icon={action.icon}
            label={action.label}
            onClick={action.onSelect}
            onLongPress={action.onLongPress}
            disabled={action.disabled}
            active={action.active}
            tone={action.tone}
          />
        )}
        {historyPlacement === 'bar' && historyItem && (
          <BarIconButton
            icon={historyItem.icon}
            label={historyItem.label}
            onClick={historyItem.onSelect}
            active={historyActive}
          />
        )}

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

        {/* Validation errors: a warning that takes you to the source editor,
            where the offending fields can actually be inspected and fixed. */}
        {hasValidationErrors && docId && (
          <a
            href={sourceUrl(docId, sourcePath)}
            aria-label="Validation errors"
            title="Validation errors — open the source editor"
            className="inline-flex items-center justify-center h-10 w-10 rounded-full state-layer shrink-0"
          >
            <span
              className="material-symbols-outlined"
              style={{ fontSize: 22, color: MATERIAL_ORANGE }}
            >
              warning
            </span>
          </a>
        )}

        {/* Kebab — only the actions that didn't fit on the bar (plus Sharing
            for non-admins). Hidden entirely when everything fits. */}
        {menuItems.length > 0 && <OverflowMenu items={menuItems} />}
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
