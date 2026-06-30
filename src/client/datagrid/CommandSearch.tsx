import { useState, useRef, useEffect, useCallback } from 'preact/hooks';
import { Icon } from '@/components/ui/icon';
import type { SearchableEntry } from './commands';

interface CommandSearchProps {
  entries: SearchableEntry[];
}

export function CommandSearch({ entries }: CommandSearchProps) {
  const [query, setQuery] = useState('');
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = query.trim()
    ? entries.filter(e => {
        const q = query.toLowerCase();
        return e.label.toLowerCase().includes(q) || e.group.toLowerCase().includes(q);
      })
    : [];

  const isOpen = open && filtered.length > 0;

  // Reset highlight when results change
  useEffect(() => { setHighlightIndex(0); }, [query]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (!isOpen || !listRef.current) return;
    const item = listRef.current.children[highlightIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [highlightIndex, isOpen]);

  const execute = useCallback((entry: SearchableEntry) => {
    entry.execute();
    setQuery('');
    setOpen(false);
    inputRef.current?.blur();
  }, []);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIndex(i => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && isOpen) {
      e.preventDefault();
      const entry = filtered[highlightIndex];
      if (entry) execute(entry);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (query) {
        setQuery('');
      } else {
        setOpen(false);
        inputRef.current?.blur();
      }
    }
  };

  return (
    <div className="relative">
      <div className="relative">
        <Icon name="search" size="0.875rem" className="absolute left-1.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder="Menu"
          className="h-7 w-[80px] rounded-sm border bg-background px-6 text-xs outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground focus:w-[180px] transition-all"
          onInput={(e) => {
            setQuery((e.target as HTMLInputElement).value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // Delay to allow click on dropdown item
            setTimeout(() => setOpen(false), 150);
          }}
          onKeyDown={handleKeyDown}
        />
      </div>

      {isOpen && (
        <div
          ref={listRef}
          className="absolute top-full left-0 mt-1 z-50 w-[320px] max-h-[300px] overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {filtered.map((entry, i) => (
            <button
              key={entry.id}
              className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none cursor-default select-none ${
                i === highlightIndex ? 'bg-accent text-accent-foreground' : ''
              } ${!entry.isEnabled ? 'opacity-50 pointer-events-none' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault(); // Prevent blur
                execute(entry);
              }}
              onMouseEnter={() => setHighlightIndex(i)}
            >
              {entry.icon && (
                <Icon name={entry.icon} size="1rem" className="shrink-0" />
              )}
              <span className="truncate">{entry.label}</span>
              <span className="ml-1 text-xs text-muted-foreground truncate">{entry.group}</span>
              {entry.shortcut && (
                <span className="ml-auto text-xs tracking-widest text-muted-foreground shrink-0">{entry.shortcut}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
