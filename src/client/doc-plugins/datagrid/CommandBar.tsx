import {
  ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut,
} from '@/components/ui/context-menu';
import type { ResolvedEntry } from './commands';

// ------------------------------------------------------------
// CommandContextMenuContent — renders entries inside a Radix ContextMenuContent
// (desktop right-click menus; the menubar/toolbar renderers were removed in
// the mobile-first redesign — commands are surfaced via the bottom bars and
// bottom sheets instead).
// ------------------------------------------------------------

interface CommandContextMenuContentProps {
  entries: ResolvedEntry[];
}

export function CommandContextMenuContent({ entries }: CommandContextMenuContentProps) {
  return (
    <ContextMenuContent>
      {entries.map((entry, i) => {
        if (entry.kind === 'separator') {
          return <ContextMenuSeparator key={`sep-${i}`} />;
        }
        if (entry.kind === 'submenu') return null; // submenus not supported in context menus
        return (
          <ContextMenuItem
            key={entry.id}
            disabled={!entry.isEnabled}
            className={entry.danger ? 'text-destructive focus:text-destructive' : undefined}
            onSelect={entry.execute}
          >
            {entry.icon && <span className="material-symbols-outlined" style={{ fontSize: '1rem' }}>{entry.icon}</span>}
            {entry.label}
            {entry.shortcut && <ContextMenuShortcut>{entry.shortcut}</ContextMenuShortcut>}
          </ContextMenuItem>
        );
      })}
    </ContextMenuContent>
  );
}
