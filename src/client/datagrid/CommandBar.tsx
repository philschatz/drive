import * as Toolbar from '@radix-ui/react-toolbar';
import { Icon } from '@/components/ui/icon';
import {
  Menubar, MenubarMenu, MenubarTrigger, MenubarContent,
  MenubarItem, MenubarCheckboxItem, MenubarSeparator, MenubarShortcut,
  MenubarSub, MenubarSubTrigger, MenubarSubContent,
} from '@/components/ui/menubar';
import {
  ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut,
} from '@/components/ui/context-menu';
import {
  Select, SelectTrigger, SelectContent, SelectItem,
} from '@/components/ui/select';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import type { ResolvedEntry, ResolvedMenu } from './commands';
import { ColorPicker, FONT_SIZES } from './FormattingToolbar';

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
          {entry.icon && <Icon name={entry.icon} size="1rem" className="mr-2" />}
          {entry.label}
        </MenubarSubTrigger>
        <MenubarSubContent className={isColor ? 'p-2 min-w-0' : undefined}>
          {isColor ? (
            <div className="grid grid-cols-10 gap-1">
              {entry.children.map(child => {
                if (child.kind !== 'command' || child.label === '__reset__') return null;
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
      <MenubarItem disabled={!entry.isEnabled} onSelect={entry.execute} style={entry.style}>
        <Icon name={entry.icon} className="mr-2 rounded-sm" />
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
        style={entry.style}
      >
        {entry.label}
        {entry.shortcut && <MenubarShortcut>{entry.shortcut}</MenubarShortcut>}
      </MenubarCheckboxItem>
    );
  }

  return (
    <MenubarItem disabled={!entry.isEnabled} onSelect={entry.execute} style={entry.style}>
      {entry.icon && <Icon name={entry.icon} className="mr-2" />}
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
    <Toolbar.Root className="flex items-center gap-1" aria-label="Spreadsheet formatting" loop>
      {entries.map((entry, i) => {
        if (entry.kind === 'separator') {
          return <Toolbar.Separator key={`sep-${i}`} orientation="vertical" className="w-px h-6 bg-border mx-1" />;
        }

        if (entry.kind === 'submenu') {
          return <ToolbarSubmenuEntry key={entry.id} entry={entry} />;
        }

        const isToggle = entry.isChecked !== undefined;
        const variant = isToggle && entry.isChecked ? 'active' : 'ghost';
        return (
          <span key={entry.id} className="contents">
            {entry.toolbarDividerBefore && (
              <Toolbar.Separator orientation="vertical" className="w-px h-6 bg-border mx-1" />
            )}
            <Toolbar.Button asChild>
              <Button
                variant={variant}
                size="icon"
                onClick={entry.execute}
                disabled={!entry.isEnabled}
                title={entry.shortcut ? `${entry.label} (${entry.shortcut})` : entry.label}
              >
                {entry.icon && <Icon name={entry.icon} />}
              </Button>
            </Toolbar.Button>
          </span>
        );
      })}
    </Toolbar.Root>
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
          <SelectTrigger className="h-7 w-[120px] text-xs" placeholder="Font" />
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

  // Font size input with +/- buttons
  if (entry.id === 'font-size') {
    const currentLabel = entry.currentValueLabel || 'Default';
    const currentSize = parseInt(currentLabel, 10) || null;
    const defaultSize = 11;

    const decrement = () => {
      const effective = currentSize ?? defaultSize;
      const smaller = FONT_SIZES.filter(s => s < effective);
      const target = smaller.length > 0 ? smaller[smaller.length - 1] : FONT_SIZES[0];
      const child = entry.children.find(c => c.kind === 'command' && c.label === String(target));
      if (child && child.kind === 'command') child.execute();
      else entry.executeCustom?.(String(target));
    };

    const increment = () => {
      const effective = currentSize ?? defaultSize;
      const larger = FONT_SIZES.filter(s => s > effective);
      const target = larger.length > 0 ? larger[0] : FONT_SIZES[FONT_SIZES.length - 1];
      const child = entry.children.find(c => c.kind === 'command' && c.label === String(target));
      if (child && child.kind === 'command') child.execute();
      else entry.executeCustom?.(String(target));
    };

    const applySize = (value: string) => {
      const parsed = parseInt(value, 10);
      if (!parsed || parsed < 1 || parsed > 999) return;
      const child = entry.children.find(c => c.kind === 'command' && c.label === String(parsed));
      if (child && child.kind === 'command') child.execute();
      else entry.executeCustom?.(String(parsed));
    };

    return (
      <span className="contents">
        {divider}
        <div className="flex items-center">
          <Button variant="ghost" size="icon" className="h-7 w-7 rounded-r-none" onClick={decrement} disabled={!entry.isEnabled} title="Decrease font size">
            <Icon name="remove" size="1rem" />
          </Button>
          <input
            type="text"
            className="h-7 w-[40px] text-xs text-center border border-input rounded bg-background outline-none"
            value={currentLabel === 'Default' ? '' : currentLabel}
            placeholder="--"
            disabled={!entry.isEnabled}
            onKeyDown={(e: any) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                applySize(e.currentTarget.value);
                e.currentTarget.blur();
              }
            }}
            onBlur={(e: any) => applySize(e.currentTarget.value)}
            onFocus={(e: any) => e.currentTarget.select()}
            onInput={(e: any) => {
              // Allow only digits in the input
              e.currentTarget.value = e.currentTarget.value.replace(/\D/g, '');
            }}
          />
          <Button variant="ghost" size="icon" className="h-7 w-7 rounded-l-none" onClick={increment} disabled={!entry.isEnabled} title="Increase font size">
            <Icon name="add" size="1rem" />
          </Button>
        </div>
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
            else entry.executeCustom?.(c);
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
    const bgChild = entry.children.find(c => c.kind === 'command' && c.isChecked && c.id !== 'bg-color-reset');
    const current = bgChild?.kind === 'command' ? bgChild.label : undefined;
    return (
      <span className="contents">
        {divider}
        <ColorPicker
          value={current || undefined}
          onChange={(c) => {
            const child = entry.children.find(ch => ch.kind === 'command' && ch.label === c);
            if (child && child.kind === 'command') child.execute();
            else entry.executeCustom?.(c);
          }}
          onReset={() => {
            const resetChild = entry.children.find(ch => ch.kind === 'command' && ch.id === 'bg-color-reset');
            if (resetChild && resetChild.kind === 'command') resetChild.execute();
          }}
          icon="format_color_fill"
          title="Fill color"
          defaultColor="transparent"
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
          <SelectTrigger className="h-7 w-[110px] text-xs" placeholder="Format" />
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
            <Button variant="ghost" size="icon" className="h-7 w-7" disabled={!entry.isEnabled} title="Borders">
              <Icon name="border_all" size="1rem" />
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
                    {child.icon && <Icon name={child.icon} size="1.1rem" />}
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
      <Button variant="ghost" size="icon" disabled={!entry.isEnabled} title={entry.label}>
        {entry.icon && <Icon name={entry.icon} />}
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
            {entry.icon && <Icon name={entry.icon} size="1rem" />}
            {entry.label}
            {entry.shortcut && <ContextMenuShortcut>{entry.shortcut}</ContextMenuShortcut>}
          </ContextMenuItem>
        );
      })}
    </ContextMenuContent>
  );
}
