import {
  Menubar, MenubarMenu, MenubarTrigger, MenubarContent,
  MenubarItem, MenubarCheckboxItem, MenubarSeparator, MenubarShortcut,
  MenubarSub, MenubarSubTrigger, MenubarSubContent,
} from '@/components/ui/menubar';
import {
  ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut,
} from '@/components/ui/context-menu';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import type { ResolvedEntry, ResolvedMenu } from './commands';
import { ColorPicker } from './FormattingToolbar';

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
              <MenuEntry key={entry.kind === 'command' ? entry.id : entry.kind === 'submenu' ? entry.id : `sep-${i}`} entry={entry} />
            ))}
          </MenubarContent>
        </MenubarMenu>
      ))}
    </Menubar>
  );
}

function MenuEntry({ entry }: { entry: ResolvedEntry }) {
  if (entry.kind === 'separator') return <MenubarSeparator />;

  if (entry.kind === 'submenu') {
    // Color submenus render a grid instead of individual menu items
    const isColor = entry.id === 'text-color' || entry.id === 'bg-color';
    return (
      <MenubarSub>
        <MenubarSubTrigger disabled={!entry.isEnabled}>
          {entry.icon && <span className="material-symbols-outlined mr-2" style={{ fontSize: '1rem' }}>{entry.icon}</span>}
          {entry.label}
        </MenubarSubTrigger>
        <MenubarSubContent className={isColor ? 'p-2 min-w-0' : undefined}>
          {isColor ? (
            <div className="grid grid-cols-10 gap-1">
              {entry.children.map(child => {
                if (child.kind !== 'command') return null;
                return (
                  <button
                    key={child.id}
                    className="w-5 h-5 rounded-sm border border-gray-300 cursor-pointer hover:ring-2 ring-blue-500 focus:ring-2 focus:outline-none"
                    style={{ background: child.label }}
                    title={child.label}
                    onClick={child.execute}
                  />
                );
              })}
            </div>
          ) : (
            entry.children.map((child, i) => (
              <MenuEntry key={child.kind === 'command' ? child.id : child.kind === 'submenu' ? child.id : `sep-${i}`} entry={child} />
            ))
          )}
        </MenubarSubContent>
      </MenubarSub>
    );
  }

  // Items with an icon: use MenubarItem and indicate checked via icon styling (keeps alignment)
  if (entry.isChecked !== undefined && entry.icon) {
    return (
      <MenubarItem disabled={!entry.isEnabled} onSelect={entry.execute}>
        <span className={`material-symbols-outlined mr-2 rounded-sm ${entry.isChecked ? 'bg-foreground text-background' : ''}`}>{entry.icon}</span>
        {entry.label}
        {entry.shortcut && <MenubarShortcut>{entry.shortcut}</MenubarShortcut>}
      </MenubarItem>
    );
  }

  // Items without an icon: use checkbox item with checkmark indicator
  if (entry.isChecked !== undefined) {
    return (
      <MenubarCheckboxItem
        checked={entry.isChecked}
        disabled={!entry.isEnabled}
        onCheckedChange={entry.execute}
      >
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

        if (entry.kind === 'submenu') {
          return <ToolbarSubmenuEntry key={entry.id} entry={entry} />;
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

// Render toolbar submenu entries as appropriate widgets
function ToolbarSubmenuEntry({ entry }: { entry: ResolvedEntry & { kind: 'submenu' } }) {
  const divider = entry.toolbarDividerBefore ? <div className="w-px h-6 bg-border mx-1" /> : null;

  // Font family select
  if (entry.id === 'font-family') {
    const current = entry.currentValueLabel || 'Default';
    return (
      <span className="contents">
        {divider}
        <Select
          value={current}
          onValueChange={(v: string) => {
            const child = entry.children.find(c => c.kind === 'command' && c.label === v);
            if (child && child.kind === 'command') child.execute();
          }}
          disabled={!entry.isEnabled}
        >
          <SelectTrigger className="h-7 w-[120px] text-xs">
            <SelectValue placeholder="Font" />
          </SelectTrigger>
          <SelectContent>
            {entry.children.map(child => {
              if (child.kind !== 'command') return null;
              return (
                <SelectItem key={child.id} value={child.label} style={child.label !== 'Default' ? { fontFamily: child.label } : undefined}>
                  {child.label}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </span>
    );
  }

  // Font size select
  if (entry.id === 'font-size') {
    const current = entry.currentValueLabel || 'Default';
    return (
      <span className="contents">
        {divider}
        <Select
          value={current}
          onValueChange={(v: string) => {
            const child = entry.children.find(c => c.kind === 'command' && c.label === v);
            if (child && child.kind === 'command') child.execute();
          }}
          disabled={!entry.isEnabled}
        >
          <SelectTrigger className="h-7 w-[56px] text-xs">
            <SelectValue placeholder="Size" />
          </SelectTrigger>
          <SelectContent>
            {entry.children.map(child => {
              if (child.kind !== 'command') return null;
              return <SelectItem key={child.id} value={child.label}>{child.label}</SelectItem>;
            })}
          </SelectContent>
        </Select>
      </span>
    );
  }

  // Text color picker
  if (entry.id === 'text-color') {
    const currentChild = entry.children.find(c => c.kind === 'command' && c.isChecked);
    const current = currentChild?.kind === 'command' ? currentChild.label : undefined;
    return (
      <span className="contents">
        {divider}
        <ColorPicker
          value={current || undefined}
          onChange={(c) => {
            const child = entry.children.find(ch => ch.kind === 'command' && ch.label === c);
            if (child && child.kind === 'command') child.execute();
          }}
          icon="format_color_text"
          title="Text color"
          disabled={!entry.isEnabled}
        />
      </span>
    );
  }

  // Background color picker
  if (entry.id === 'bg-color') {
    const bgChild = entry.children.find(c => c.kind === 'command' && c.isChecked);
    const current = bgChild?.kind === 'command' ? bgChild.label : undefined;
    return (
      <span className="contents">
        {divider}
        <ColorPicker
          value={current || undefined}
          onChange={(c) => {
            const child = entry.children.find(ch => ch.kind === 'command' && ch.label === c);
            if (child && child.kind === 'command') child.execute();
          }}
          icon="format_color_fill"
          title="Fill color"
          disabled={!entry.isEnabled}
        />
      </span>
    );
  }

  // Number format select
  if (entry.id === 'number-format') {
    const current = entry.currentValueLabel || 'Automatic';
    return (
      <span className="contents">
        {divider}
        <Select
          value={current}
          onValueChange={(v: string) => {
            const child = entry.children.find(c => c.kind === 'command' && c.label === v);
            if (child && child.kind === 'command') child.execute();
          }}
          disabled={!entry.isEnabled}
        >
          <SelectTrigger className="h-7 w-[100px] text-xs">
            <SelectValue placeholder="Format" />
          </SelectTrigger>
          <SelectContent>
            {entry.children.map(child => {
              if (child.kind !== 'command') return null;
              return <SelectItem key={child.id} value={child.label}>{child.label}</SelectItem>;
            })}
          </SelectContent>
        </Select>
      </span>
    );
  }

  // Borders picker
  if (entry.id === 'borders') {
    return (
      <span className="contents">
        {divider}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" className="h-7 w-7" disabled={!entry.isEnabled} title="Borders">
              <span className="material-symbols-outlined" style={{ fontSize: '1rem' }}>border_all</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="p-2 w-auto" align="start">
            <div className="grid grid-cols-4 gap-1">
              {entry.children.map(child => {
                if (child.kind !== 'command') return null;
                return (
                  <button
                    key={child.id}
                    className="w-8 h-8 rounded-sm border border-gray-200 cursor-pointer hover:bg-accent flex items-center justify-center focus:ring-2 focus:outline-none"
                    title={child.label}
                    onClick={child.execute}
                  >
                    {child.icon && <span className="material-symbols-outlined" style={{ fontSize: '1.1rem' }}>{child.icon}</span>}
                  </button>
                );
              })}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    );
  }

  // Fallback: render as a button
  return (
    <span className="contents">
      {divider}
      <Button variant="outline" size="icon" disabled={!entry.isEnabled} title={entry.label}>
        {entry.icon && <span className="material-symbols-outlined">{entry.icon}</span>}
      </Button>
    </span>
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
