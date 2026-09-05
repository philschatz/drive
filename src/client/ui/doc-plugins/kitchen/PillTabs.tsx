/**
 * A horizontal pill tab bar — the SheetTabsBar pill idiom (datagrid) as a
 * top-of-content section switcher. Tab state is the caller's; nothing here
 * touches the URL (rest carries only real navigation).
 */

export interface PillTab {
  id: string;
  label: string;
  /** Small trailing count, e.g. ready recipes or items to buy. */
  count?: number;
}

export function PillTabs({ tabs, active, onSelect }: {
  tabs: PillTab[];
  active: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto py-2" role="tablist" data-testid="kitchen-tabs">
      {tabs.map(tab => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            data-tab={tab.id}
            className={
              'inline-flex items-center gap-1.5 rounded-full px-3 h-8 whitespace-nowrap md-label-large state-layer shrink-0' +
              (isActive ? ' bg-secondary-container text-on-secondary-container font-semibold' : ' text-muted-foreground')
            }
            onClick={() => onSelect(tab.id)}
          >
            {tab.label}
            {tab.count !== undefined && <span className="text-xs opacity-70">{tab.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
