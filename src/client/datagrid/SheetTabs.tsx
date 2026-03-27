import { useState, useRef, useCallback, useEffect } from 'preact/hooks';
import type { RefObject } from 'preact';

export interface SheetTabInfo {
  id: string;
  name: string;
  hidden?: boolean;
}

interface SheetTabsProps {
  sheets: SheetTabInfo[];
  currentSheetId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRename: (id: string, name: string) => void;
  onReorder: (draggedId: string, dropIndex: number) => void;
  onContextMenu: (id: string) => void;
  onUnhide: (id: string) => void;
  /** Ref that exposes a function to trigger inline rename from outside. */
  renameRef?: RefObject<((id: string) => void) | null>;
}

export function SheetTabs({ sheets, currentSheetId, onSelect, onAdd, onRename, onReorder, onContextMenu, onUnhide, renameRef }: SheetTabsProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [hiddenMenuOpen, setHiddenMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<{ id: string; startX: number } | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const hiddenMenuRef = useRef<HTMLDivElement>(null);

  const visibleSheets = sheets.filter(s => !s.hidden);
  const hiddenSheets = sheets.filter(s => s.hidden);

  const startRename = useCallback((id: string, currentName: string) => {
    setRenamingId(id);
    setRenameValue(currentName);
    setTimeout(() => inputRef.current?.select(), 0);
  }, []);

  // Expose startRename to parent via ref
  useEffect(() => {
    if (renameRef) {
      renameRef.current = (id: string) => {
        const sheet = sheets.find(s => s.id === id);
        if (sheet) startRename(id, sheet.name);
      };
      return () => { renameRef.current = null; };
    }
  }, [renameRef, sheets, startRename]);

  // Close hidden sheets menu on outside click
  useEffect(() => {
    if (!hiddenMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (hiddenMenuRef.current && !hiddenMenuRef.current.contains(e.target as Node)) {
        setHiddenMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [hiddenMenuOpen]);

  const commitRename = useCallback(() => {
    if (renamingId && renameValue.trim()) {
      onRename(renamingId, renameValue.trim());
    }
    setRenamingId(null);
  }, [renamingId, renameValue, onRename]);

  const handleTabMouseDown = useCallback((id: string, e: MouseEvent) => {
    if (e.button !== 0 || renamingId) return;
    const startX = e.clientX;
    let dragging = false;

    const onMouseMove = (me: MouseEvent) => {
      if (!dragging) {
        if (Math.abs(me.clientX - startX) < 5) return;
        dragging = true;
        dragRef.current = { id, startX };
        document.body.style.cursor = 'grabbing';
      }

      const el = document.elementFromPoint(me.clientX, me.clientY);
      const tab = el?.closest('[data-sheet-tab]') as HTMLElement | null;
      if (tab) {
        const tabIdx = visibleSheets.findIndex(s => s.id === tab.dataset.sheetTab);
        if (tabIdx >= 0) {
          const rect = tab.getBoundingClientRect();
          const mid = (rect.left + rect.right) / 2;
          setDropIndex(me.clientX < mid ? tabIdx : tabIdx + 1);
        }
      }
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';

      if (dragging && dragRef.current) {
        setDropIndex(prev => {
          if (prev !== null && dragRef.current) {
            onReorder(dragRef.current.id, prev);
          }
          return null;
        });
      }
      dragRef.current = null;
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [renamingId, visibleSheets, onReorder]);

  return (
    <div className="sheet-tabs-bar">
      <div className="sheet-hidden-menu" ref={hiddenMenuRef}>
        <button
          className="sheet-tab-add"
          onClick={() => setHiddenMenuOpen(o => !o)}
          title="Sheets"
        >
          <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>menu</span>
        </button>
        {hiddenMenuOpen && (
          <div className="sheet-hidden-popup">
            {sheets.map(sheet => (
              <button
                key={sheet.id}
                className={'sheet-hidden-item' + (sheet.hidden ? ' hidden-sheet' : '')}
                onClick={() => {
                  if (sheet.hidden) {
                    onUnhide(sheet.id);
                  } else {
                    onSelect(sheet.id);
                  }
                  setHiddenMenuOpen(false);
                }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: '16px', width: '22px', marginRight: '4px' }}>
                  {sheet.id === currentSheetId ? 'check' : ''}
                </span>
                {sheet.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <button className="sheet-tab-add" onClick={onAdd} title="Add sheet">
        <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>add</span>
      </button>
      <div className="sheet-tabs-scroll">
      {visibleSheets.map((sheet, i) => {
        const isActive = sheet.id === currentSheetId;
        const isRenaming = sheet.id === renamingId;
        const showDropLeft = dropIndex === i && dragRef.current?.id !== sheet.id;
        const showDropRight = dropIndex === i + 1 && i === visibleSheets.length - 1 && dragRef.current?.id !== sheet.id;

        return (
          <button
            key={sheet.id}
            data-sheet-tab={sheet.id}
            className={'sheet-tab' + (isActive ? ' active' : '') + (showDropLeft ? ' drop-left' : '') + (showDropRight ? ' drop-right' : '')}
            onClick={() => { if (!isRenaming) onSelect(sheet.id); }}
            onDblClick={() => startRename(sheet.id, sheet.name)}
            onMouseDown={(e: any) => handleTabMouseDown(sheet.id, e)}
            onContextMenu={() => {
              onContextMenu(sheet.id);
            }}
          >
            {isRenaming ? (
              <input
                ref={inputRef}
                className="sheet-tab-rename"
                value={renameValue}
                onInput={(e: any) => setRenameValue(e.currentTarget.value)}
                onBlur={commitRename}
                onKeyDown={(e: any) => {
                  if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                  if (e.key === 'Escape') { e.preventDefault(); setRenamingId(null); }
                }}
                onClick={(e: any) => e.stopPropagation()}
              />
            ) : (
              sheet.name
            )}
          </button>
        );
      })}
      </div>
    </div>
  );
}
