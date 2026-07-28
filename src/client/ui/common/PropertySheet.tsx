/**
 * The Material bottom sheet every item editor is built from: one thing edited at
 * a time.
 *
 * **List mode** shows each property as an `md-list-item` — icon, label, and the
 * current value as supporting text — so the whole item is legible at a glance on
 * a phone. Tapping a row enters **detail mode**, which replaces the list with
 * that property's editor alone. This is the standard MD3 mobile pattern, and it
 * removes the "wall of form controls" the flat editors had.
 *
 * A pane editing a single field marks itself `transactional` and wraps its control
 * in a `FieldEditor`, which owns the draft and offers Cancel/Save. Those panes lose
 * the Back arrow, so the edit has exactly one discard gesture and one commit
 * gesture. Multi-control panes (an event's When, a recurrence rule) and dropdowns
 * still auto-save and keep Back.
 *
 * Peer presence rides along at both levels: a list row carries a PresenceDot in
 * its trailing slot, so you can see which property a peer is editing without
 * opening anything, and the detail pane repeats the dot beside the field's own
 * title. Either way the affected UI greys to 0.5 but stays fully interactive —
 * the dot informs, it does not lock. (Automerge merges concurrent edits; the
 * signal exists to avoid surprise, not to serialise access.)
 *
 * The sheet renders its own <Sheet>, so callers pass `open` rather than wrapping
 * it. That is deliberate: <Sheet> unmounts its children when closed, which resets
 * `detailId` on every reopen for free.
 */
import { useState, useRef, useLayoutEffect, useCallback } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { PresenceDot } from './PeerDot';
import type { PeerFieldInfo } from './presence';

/**
 * A sheet-level action (Delete, Archive) as a Material list row — the same shape
 * the app's other option sheets use (FriendOptionsSheet, MemberOptionsSheet), so
 * a destructive action reads as an error-toned row rather than a stray button.
 *
 * `md-list-item` has no implicit ARIA role while unregistered under jsdom, so
 * these always carry a testid; query them by that, not by `getByRole('button')`.
 */
export function SheetActionItem({ icon, label, destructive, onClick, 'data-testid': testId }: {
  icon: string;
  label: string;
  destructive?: boolean;
  onClick: () => void;
  'data-testid': string;
}) {
  const tone = destructive ? { color: 'var(--md-sys-color-error)' } : undefined;
  return (
    <md-list-item type="button" data-testid={testId} onClick={onClick}>
      <md-icon slot="start" style={tone}>{icon}</md-icon>
      <div slot="headline" style={tone}>{label}</div>
    </md-list-item>
  );
}

/** Divider + list wrapper for a run of {@link SheetActionItem}s. */
export function SheetActions({ children }: { children: ComponentChildren }) {
  return (
    <div className="mt-2">
      <md-divider role="separator" />
      <md-list style={{ background: 'transparent' }}>{children}</md-list>
    </div>
  );
}

export interface PropertyRenderCtx {
  /** Return to the list. Call after a terminal interaction (Enter, picking a value). */
  back: () => void;
}

export interface PropertyDef {
  /** Stable id; also the row's testid stem and the default presence field id. */
  id: string;
  /** Row headline. The detail pane keeps the sheet's own title, not this. */
  label: string;
  /** material-symbols glyph for the leading slot. */
  icon: string;
  /** Current value as text. Empty → a muted "Add <label>" placeholder. */
  summary: () => string;
  /** The detail pane. Mark the control to focus with `data-autofocus`. */
  render?: (ctx: PropertyRenderCtx) => ComponentChildren;
  /**
   * A control small enough to live in the row itself (a colour swatch, a
   * switch) — rendered in the trailing slot, with no detail pane. Rows with
   * `inline` and no `render` don't navigate.
   */
  inline?: () => ComponentChildren;
  hidden?: boolean;
  /**
   * This pane edits one field and supplies its own Cancel/Save (see `FieldEditor`),
   * so the header's Back arrow is dropped: Cancel is the single discard gesture and
   * Save the single commit gesture, rather than Back silently meaning "save".
   * Grouped panes leave this off — they auto-save and keep Back.
   */
  transactional?: boolean;
  /**
   * Presence field ids that light this row's dot; defaults to `[id]`. Grouped
   * rows (a calendar event's "When" covers date/time/all-day/duration) list every
   * member field, since peers broadcast at input granularity.
   */
  presenceIds?: string[];
}

export interface PropertySheetProps {
  open: boolean;
  /** Header text. Constant across list and detail mode, so it stays a stable anchor. */
  title: string;
  properties: PropertyDef[];
  peerFocusedFields?: Record<string, PeerFieldInfo>;
  /** Property to open into. `isNew` items jump straight to their primary field. */
  initialDetailId?: string | null;
  onClose: () => void;
  /** Rendered below the list, list mode only: Delete / Archive / a log. */
  footer?: ComponentChildren;
  /** Notice about the item as a whole (e.g. "this is one occurrence"), both modes. */
  banner?: ComponentChildren;
  /** Extra classes for the sheet surface (e.g. the calendar editor's `.panel` hook). */
  contentClassName?: string;
  /**
   * Blur the focused element before closing so an auto-save commit-on-blur runs.
   * Chrome fires no `focusout` when a focused element is simply removed from the
   * DOM, so Escape-to-close would otherwise drop what you just typed. Only the
   * auto-saving panes need it — a `transactional` pane commits on Save, and in
   * jsdom a click on Close doesn't move focus, so an unconditional blur would fire
   * a spurious commit.
   */
  flushOnClose?: boolean;
  'data-testid'?: string;
}

export function PropertySheet({
  open,
  title,
  properties,
  peerFocusedFields,
  initialDetailId = null,
  onClose,
  footer,
  banner,
  contentClassName,
  flushOnClose,
  'data-testid': testId,
}: PropertySheetProps) {
  return open ? (
    <PropertySheetBody
      title={title}
      properties={properties}
      peerFocusedFields={peerFocusedFields}
      initialDetailId={initialDetailId}
      onClose={onClose}
      footer={footer}
      banner={banner}
      contentClassName={contentClassName}
      flushOnClose={flushOnClose}
      data-testid={testId}
    />
  ) : null;
}

/**
 * Split out so `detailId` is initialised from `initialDetailId` on open and
 * nowhere else — mounting only when open means reopening resets it, while
 * `onAddAnother` (which swaps the item without closing) leaves it alone.
 */
function PropertySheetBody({
  title,
  properties,
  peerFocusedFields,
  initialDetailId,
  onClose,
  footer,
  banner,
  contentClassName,
  flushOnClose,
  'data-testid': testId,
}: Omit<PropertySheetProps, 'open'>) {
  const [detailId, setDetailId] = useState<string | null>(initialDetailId ?? null);
  const paneRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const lastRowIdRef = useRef<string | null>(null);

  const visible = properties.filter(p => !p.hidden);
  const detail = detailId ? visible.find(p => p.id === detailId) : undefined;

  /** Is a peer editing any field behind this property? */
  const peerOn = (def: PropertyDef) =>
    (def.presenceIds ?? [def.id]).some(id => !!peerFocusedFields?.[id]);

  const back = useCallback(() => setDetailId(null), []);

  const close = useCallback(() => {
    // Commit-on-blur editors need the focused field to blur while it is still in
    // the document; removing it silently discards the edit.
    if (flushOnClose) (document.activeElement as HTMLElement | null)?.blur?.();
    onClose();
  }, [flushOnClose, onClose]);

  // Escape pops detail → list rather than closing the whole sheet.
  const handleEscape = useCallback(() => {
    if (!detailId) return false;
    setDetailId(null);
    return true;
  }, [detailId]);

  // useLayoutEffect, not useEffect: iOS only raises the soft keyboard for a
  // focus() inside the transient user-activation window, which survives a
  // microtask but not a post-paint callback.
  useLayoutEffect(() => {
    if (!detailId) {
      if (lastRowIdRef.current) {
        listRef.current
          ?.querySelector<HTMLElement>(`[data-row-id="${lastRowIdRef.current}"]`)
          ?.focus?.();
      }
      return;
    }
    const pane = paneRef.current;
    const el =
      pane?.querySelector<HTMLElement>('[data-autofocus]') ??
      pane?.querySelector<HTMLElement>(
        'input, textarea, select, md-outlined-text-field, md-outlined-select, button',
      );
    el?.focus?.();
    // A Material field delegates focus to an <input> that Lit renders into its
    // shadow root *asynchronously*, so on the pane's first paint there is nothing
    // to delegate to yet and the focus() above is silently dropped — leaving
    // <body> focused, the iOS keyboard down, and keystrokes going to the
    // document. Retry once the element has rendered. `updateComplete` settles in
    // a microtask, so this is still inside the tap's user-activation window; the
    // activeElement guard keeps it from stealing focus back from a peer field the
    // user has since moved to.
    const rendered = (el as any)?.updateComplete;
    if (rendered?.then) {
      rendered.then(() => {
        if (document.activeElement === document.body) el?.focus?.();
      });
    }
  }, [detailId]);

  return (
    <Sheet open onOpenChange={(o: boolean) => { if (!o) close(); }} onEscape={handleEscape}>
      <SheetContent side="bottom" className={`max-h-[85vh] p-4${contentClassName ? ` ${contentClassName}` : ''}`}>
        <SheetHeader>
          <div className="flex items-center gap-1 pr-8">
            {/* A transactional pane has its own Cancel, so a Back arrow would be a
                second, ambiguous way out of the same edit. */}
            {detail && !detail.transactional && (
              <button
                aria-label="Back"
                className="inline-flex items-center justify-center h-10 w-10 -ml-2 rounded-full state-layer shrink-0 focus:outline-none"
                onClick={back}
              >
                <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 24 }}>
                  arrow_back
                </span>
              </button>
            )}
            <SheetTitle className="truncate">{title}</SheetTitle>
          </div>
        </SheetHeader>

        {banner && <div className="mt-2">{banner}</div>}

        {detail ? (
          <div ref={paneRef} data-testid={testId ? `${testId}-detail` : undefined} className="mt-4">
            {/* A title line above the field, carrying the peer dot. Shown for a
                grouped pane (where it names the cluster) and whenever a peer is
                present (so the dot has a home) — but not for a lone field with
                no peer, where it would just repeat the field's floating label. */}
            {(peerOn(detail) || (detail.presenceIds?.length ?? 0) > 1) && (
              <div className="flex items-center gap-1.5 mb-2">
                <span className="md-label-large text-on-surface-variant">{detail.label}</span>
                <PresenceDot
                  fieldIds={detail.presenceIds ?? [detail.id]}
                  peerFocusedFields={peerFocusedFields}
                />
              </div>
            )}
            {/* Greyed while a peer is in it, never disabled — Automerge merges
                concurrent edits, so this is a heads-up, not a lock. */}
            <div style={{ opacity: peerOn(detail) ? 0.5 : undefined }}>
              {detail.render?.({ back })}
            </div>
          </div>
        ) : (
          <div ref={listRef} data-testid={testId} className="mt-2">
            {/* md-list defaults to --md-sys-color-surface, which fights the
                sheet's own surface tone. */}
            <md-list style={{ background: 'transparent' }}>
              {visible.map(def => {
                const value = def.summary();
                const navigates = !!def.render;
                return (
                  <md-list-item
                    key={def.id}
                    type={navigates ? 'button' : 'text'}
                    data-row-id={def.id}
                    data-testid={`${def.id}-row`}
                    // Greyed while a peer is in it, but still tappable — the dot
                    // informs, it does not lock.
                    style={{ opacity: peerOn(def) ? 0.5 : undefined }}
                    onClick={navigates ? () => { lastRowIdRef.current = def.id; setDetailId(def.id); } : undefined}
                  >
                    <md-icon slot="start">{def.icon}</md-icon>
                    <div slot="headline">{def.label}</div>
                    <div slot="supporting-text" className={value ? undefined : 'opacity-60'}>
                      {value || `Add ${def.label.toLowerCase()}`}
                    </div>
                    <div slot="end" className="flex items-center gap-2">
                      <PresenceDot
                        fieldIds={def.presenceIds ?? [def.id]}
                        peerFocusedFields={peerFocusedFields}
                      />
                      {def.inline?.()}
                      {navigates && <md-icon aria-hidden="true">chevron_right</md-icon>}
                    </div>
                  </md-list-item>
                );
              })}
            </md-list>
            {footer}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
