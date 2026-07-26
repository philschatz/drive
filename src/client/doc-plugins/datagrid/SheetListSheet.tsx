import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { SheetTabInfo } from './SheetTabsBar';

/**
 * Bottom sheet listing every sheet in the document: hidden sheets are shown
 * in italics (and only to users who can unhide them), the visible/current
 * sheet gets a checkmark. Picking a hidden sheet unhides and selects it.
 */
export function SheetListSheet({
  open,
  onOpenChange,
  sheets,
  currentSheetId,
  readOnly,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sheets: SheetTabInfo[];
  currentSheetId: string;
  /** Read-only: hidden sheets are omitted (unhiding is a mutation). */
  readOnly?: boolean;
  onPick: (id: string) => void;
}) {
  const list = readOnly ? sheets.filter(s => !s.hidden) : sheets;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[70vh] p-4">
        <SheetHeader>
          <SheetTitle>Sheets</SheetTitle>
        </SheetHeader>
        {/* SheetContent doesn't forward extra props — testid goes on the list */}
        <md-list style={{ background: 'transparent' }} className="mt-2" data-testid="sheet-list-sheet">
          {list.map(sheet => (
            <md-list-item
              key={sheet.id}
              type="button"
              onClick={() => {
                // Close before acting (action-sheet convention)
                onOpenChange(false);
                onPick(sheet.id);
              }}
            >
              <md-icon slot="start">{sheet.id === currentSheetId ? 'check' : ''}</md-icon>
              <div slot="headline" className={sheet.hidden ? 'italic text-on-surface-variant' : undefined}>
                {sheet.name}
              </div>
              {sheet.hidden && <md-icon slot="end">visibility_off</md-icon>}
            </md-list-item>
          ))}
        </md-list>
      </SheetContent>
    </Sheet>
  );
}
