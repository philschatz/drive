import {
  Menubar, MenubarMenu, MenubarTrigger, MenubarContent,
  MenubarItem, MenubarCheckboxItem, MenubarSeparator, MenubarShortcut,
} from '@/components/ui/menubar';
import {
  ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut,
} from '@/components/ui/context-menu';
import { Button } from '@/components/ui/button';
import type { ResolvedEntry, ResolvedMenu } from './commands';

// ------------------------------------------------------------
// CommandMenuBar — renders the full menubar from resolved menus
// ------------------------------------------------------------

interface CommandMenuBarProps {
  menus: ResolvedMenu[];
}

export function CommandMenuBar({ menus }: CommandMenuBarProps) {
  return (
    <Menubar className="mb-1">
      {menus.map(menu => (
        <MenubarMenu key={menu.menuId}>
          <MenubarTrigger>{menu.triggerLabel}</MenubarTrigger>
          <MenubarContent>
            {menu.entries.map((entry, i) => (
              <MenuEntry key={entry.kind === 'command' ? entry.id : `sep-${i}`} entry={entry} />
            ))}
          </MenubarContent>
        </MenubarMenu>
      ))}
    </Menubar>
  );
}

function MenuEntry({ entry }: { entry: ResolvedEntry }) {
  if (entry.kind === 'separator') return <MenubarSeparator />;

  if (entry.isChecked !== undefined) {
    return (
      <MenubarCheckboxItem
        checked={entry.isChecked}
        disabled={!entry.isEnabled}
        onCheckedChange={entry.execute}
      >
        {entry.icon && <span className="material-symbols-outlined mr-2">{entry.icon}</span>}
        {entry.label}
        {entry.shortcut && <MenubarShortcut>{entry.shortcut}</MenubarShortcut>}
      </MenubarCheckboxItem>
    );
  }

  return (
    <MenubarItem disabled={!entry.isEnabled} onSelect={entry.execute}>
      {entry.icon && <span className="material-symbols-outlined mr-2">{entry.icon}</span>}
      {entry.label}
      {entry.shortcut && <MenubarShortcut>{entry.shortcut}</MenubarShortcut>}
    </MenubarItem>
  );
}

// ------------------------------------------------------------
// CommandToolbar — renders the icon button strip
// ------------------------------------------------------------

interface CommandToolbarProps {
  entries: ResolvedEntry[];
}

export function CommandToolbar({ entries }: CommandToolbarProps) {
  return (
    <div className="flex items-center gap-1">
      {entries.map((entry, i) => {
        if (entry.kind === 'separator') {
          return <div key={`sep-${i}`} className="w-px h-6 bg-border mx-1" />;
        }
        const isToggle = entry.isChecked !== undefined;
        const variant = isToggle && entry.isChecked ? 'default' : 'outline';
        return (
          <span key={entry.id} className="contents">
            {entry.toolbarDividerBefore && (
              <div className="w-px h-6 bg-border mx-1" />
            )}
            <Button
              variant={variant}
              size="icon"
              onClick={entry.execute}
              disabled={!entry.isEnabled}
              title={entry.shortcut ? `${entry.label} (${entry.shortcut})` : entry.label}
            >
              {entry.icon && <span className="material-symbols-outlined">{entry.icon}</span>}
            </Button>
          </span>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------
// CommandContextMenuContent — renders entries inside a Radix ContextMenuContent
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
