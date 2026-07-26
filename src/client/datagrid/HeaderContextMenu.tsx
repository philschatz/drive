import { useEffect, useRef } from 'preact/hooks';
import type { ResolvedEntry } from './commands';

export type HeaderMenuKind = 'row' | 'col';

/** Which page of the menu is showing: the primary actions or the kebab's overflow. */
export type HeaderMenuPage = 'main' | 'more';

function MenuItems({ entries }: { entries: (ResolvedEntry & { kind: 'command' })[] }) {
  return (
    <>
      {entries.map(entry => (
        <md-menu-item
          key={entry.id}
          disabled={!entry.isEnabled || undefined}
          onClick={entry.execute}
        >
          <md-icon slot="start">{entry.icon}</md-icon>
          <div slot="headline">{entry.label}</div>
        </md-menu-item>
      ))}
    </>
  );
}

/**
 * Context menu for a row/column header, opened by long-press (touch) or
 * right-click. The primary page holds the frequent actions; the trailing kebab
 * opens a second page with the structural ones. `@material/web` in this version
 * ships no `md-sub-menu`, so the two pages are two menus anchored to the same
 * header element.
 */
export function HeaderContextMenu({
  kind,
  anchor,
  page,
  onPageChange,
  onClose,
  resolveCommand,
  onResize,
}: {
  kind: HeaderMenuKind;
  /** The header element the menu is anchored to; null closes the menu. */
  anchor: HTMLElement | null;
  page: HeaderMenuPage;
  onPageChange: (page: HeaderMenuPage) => void;
  onClose: () => void;
  resolveCommand: (id: string) => ResolvedEntry & { kind: 'command' };
  /** Open the row-height / column-width sheet. */
  onResize: () => void;
}) {
  const mainRef = useRef<any>(null);
  const moreRef = useRef<any>(null);
  const label = kind === 'row' ? 'Row' : 'Column';

  // Drive both menus' open state from props. md-menu needs its anchor assigned
  // imperatively (it takes an element, not a selector).
  useEffect(() => {
    for (const [ref, wantOpen] of [[mainRef, page === 'main'], [moreRef, page === 'more']] as const) {
      const menu = ref.current;
      if (!menu) continue;
      const shouldOpen = !!anchor && wantOpen;
      if (shouldOpen) menu.anchorElement = anchor;
      if (menu.open !== shouldOpen) menu.open = shouldOpen;
    }
  }, [anchor, page]);

  // A dismissal (outside click / Escape) has to propagate back up, but ignore
  // the close that happens when switching pages.
  useEffect(() => {
    const onClosed = (e: Event) => {
      const menu = e.currentTarget as any;
      if (menu.dataset.switching === '1') {
        menu.dataset.switching = '0';
        return;
      }
      onClose();
    };
    const menus = [mainRef.current, moreRef.current].filter(Boolean);
    for (const m of menus) m.addEventListener('closed', onClosed);
    return () => { for (const m of menus) m.removeEventListener('closed', onClosed); };
  }, [onClose]);

  const switchPage = (next: HeaderMenuPage) => {
    // Mark the outgoing menu so its `closed` event isn't treated as a dismissal.
    const outgoing = page === 'main' ? mainRef.current : moreRef.current;
    if (outgoing) outgoing.dataset.switching = '1';
    onPageChange(next);
  };

  const primary = [
    resolveCommand('cut'),
    resolveCommand('copy'),
    resolveCommand(kind === 'row' ? 'autofill-rows' : 'autofill-cols'),
    { ...resolveCommand('delete-contents'), label: 'Clear' },
    { ...resolveCommand(kind === 'row' ? 'delete-rows' : 'delete-cols'), label: 'Delete' },
  ] as (ResolvedEntry & { kind: 'command' })[];

  const more = [
    resolveCommand(kind === 'row' ? 'freeze-rows' : 'freeze-cols'),
    { ...resolveCommand(kind === 'row' ? 'hide-rows' : 'hide-cols'), label: `Hide ${label.toLowerCase()}` },
  ] as (ResolvedEntry & { kind: 'command' })[];

  return (
    <>
      <md-menu ref={mainRef} positioning="fixed" data-testid={`header-menu-${kind}`}>
        <MenuItems entries={primary} />
        <md-divider role="separator" />
        <md-menu-item
          keep-open
          data-testid="header-menu-more"
          onClick={() => switchPage('more')}
        >
          <md-icon slot="start">more_vert</md-icon>
          <div slot="headline">More</div>
        </md-menu-item>
      </md-menu>

      <md-menu ref={moreRef} positioning="fixed" data-testid={`header-menu-${kind}-more`}>
        <md-menu-item keep-open onClick={() => switchPage('main')}>
          <md-icon slot="start">arrow_back</md-icon>
          <div slot="headline">Back</div>
        </md-menu-item>
        <md-divider role="separator" />
        <MenuItems entries={more} />
        <md-menu-item onClick={onResize}>
          <md-icon slot="start">{kind === 'row' ? 'height' : 'width_normal'}</md-icon>
          <div slot="headline">Resize</div>
        </md-menu-item>
      </md-menu>
    </>
  );
}
