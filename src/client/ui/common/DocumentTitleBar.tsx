import type { ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { ConnectionStatus } from './ConnectionStatus';
import { RenameSheet } from './RenameSheet';
import { type PresenceState } from './presence';
import { useAccess } from './useAccess';
import { useHideOnScroll } from './useHideOnScroll';
import { sourceUrl, sharePath, shareUrl } from './doc-urls';
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
 * The bar is sticky and hides itself on scroll: it owns the shared
 * `useHideOnScroll()` hook, so dragging up hides the chrome and dragging back
 * down reveals it in every document type — including ones not written yet —
 * without each editor wiring that up. A bar that does not position itself
 * (`sticky={false}`) doesn't translate either; that layout owns its hiding.
 */
export function DocumentTitleBar<P extends PeerLike>({
  icon,
  title,
  titleEditable = false,
  onRename,
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
  hidden,
  sticky = true,
  children,
}: {
  icon: string;
  title: string;
  /** Whether the user may rename — makes the title itself tappable and gates
   * the kebab's Rename item (both open the same sheet). */
  titleEditable?: boolean;
  /** Commit a new document name (from the rename sheet). */
  onRename?: (value: string) => void;
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
  /** Override the bar's own hide-on-scroll state (it hides itself by default). */
  hidden?: boolean;
  /** Set false when the bar sits in a fixed-height flex layout that positions
   * it itself (DataGrid), rather than over scrolling page content. */
  sticky?: boolean;
  children?: ComponentChildren;
}) {
  const { access } = useAccess(docId);
  const [renaming, setRenaming] = useState(false);
  // A bar positioned by someone else's layout (DataGrid's fixed-height flex
  // column) is hidden by that layout too, so it must not also translate itself.
  const autoHidden = useHideOnScroll();
  const barHidden = hidden ?? (sticky && autoHidden);

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
      onSelect: () => setRenaming(true),
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
      onSelect: () => { window.location.hash = sharePath(docId); },
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
        'flex items-center gap-1 pl-1 pr-1 min-h-14 w-full bg-page transition-transform duration-200' +
        (sticky ? ' sticky top-0 z-20' : '') +
        (barHidden ? ' -translate-y-full' : '')
      }
    >
      {/* Left side — always the back link to Home. No editor has a mode to leave
          (DataGrid's focus-mode checkmark is its own FocusTopBar). */}
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

      {/* Tapping the title renames it — but it is never an input in place. It
          opens the same transactional RenameSheet the kebab does, so the edit
          still has one explicit Save and one Cancel and a stray tap costs
          nothing. A title you may not edit stays inert text.
          `title` is the document's own name (a truncated title needs the
          tooltip); it must NOT be "Rename", which is how every spec locates the
          kebab item — see document-title-bar.test.tsx and tests-pw/ui/support.ts. */}
      {titleEditable ? (
        <button
          data-testid="doc-title"
          aria-label={`Rename ${title}`}
          title={title}
          onClick={() => setRenaming(true)}
          className="md-title-large font-bold truncate flex-1 min-w-12 text-left state-layer rounded"
        >
          {title}
        </button>
      ) : (
        <span data-testid="doc-title" className="md-title-large font-bold truncate flex-1 min-w-12">{title}</span>
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

        <ConnectionStatus peers={peers} peerTitle={peerTitle} />

        {/* Admins manage sharing, so they get the share button right on the
            bar; other access levels find Sharing in the overflow menu. */}
        {docId && isAdmin && (
          <a
            href={shareUrl(docId)}
            aria-label="Share"
            title="Share & permissions"
            className="inline-flex items-center justify-center h-10 w-10 rounded-full state-layer shrink-0"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 20 }}>share</span>
          </a>
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

      <RenameSheet
        open={renaming}
        title="Rename document"
        value={title}
        onRename={(name) => onRename?.(name)}
        onClose={() => setRenaming(false)}
        data-testid="doc-rename-sheet"
      />
    </div>
  );
}
