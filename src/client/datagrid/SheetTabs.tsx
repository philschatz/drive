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
  onContextMenu: (id: string, x: number, y: number) => void;
  /** Ref that exposes a function to trigger inline rename from outside. */
  renameRef?: RefObject<((id: string) => void) | null>;
}

export function SheetTabs({ sheets, currentSheetId, onSelect, onAdd, onRename, onReorder, onContextMenu, renameRef }: SheetTabsProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<{ id: string; startX: number } | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const visibleSheets = sheets.filter(s => !s.hidden);

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
            onContextMenu={(e: any) => {
              e.preventDefault();
              onContextMenu(sheet.id, e.clientX, e.clientY);
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
      <button className="sheet-tab-add" onClick={onAdd} title="Add sheet">
        <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>add</span>
      </button>
    </div>
  );
}
