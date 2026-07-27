/**
 * Actions for one friend, opened by tapping their row on the Friends page:
 * rename, remove, and the documents you share with them.
 */

import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { iconForType } from '../doc-plugins';
import { docUrl } from '../shared/doc-urls';
import type { FriendEntry } from './Friends';

export function FriendOptionsSheet({
  friend,
  displayName,
  onOpenChange,
  onRename,
  onRemove,
}: {
  /** The friend to act on; null closes the sheet. */
  friend: FriendEntry | null;
  displayName: string;
  onOpenChange: (open: boolean) => void;
  onRename: (friend: FriendEntry) => void;
  onRemove: (friend: FriendEntry) => void;
}) {
  return (
    <Sheet open={!!friend} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85vh] p-4 overflow-y-auto">
        {/* SheetContent doesn't forward extra props — testid goes on a wrapper */}
        <div data-testid="friend-options-sheet">
          <SheetHeader>
            <SheetTitle>{displayName}</SheetTitle>
          </SheetHeader>

          {friend && (
            <>
              <md-list style={{ background: 'transparent' }} className="mt-2">
                <md-list-item type="button" data-testid="friend-rename" onClick={() => onRename(friend)}>
                  <md-icon slot="start">edit</md-icon>
                  <div slot="headline">Rename</div>
                </md-list-item>
                <md-list-item type="button" data-testid="friend-remove" onClick={() => onRemove(friend)}>
                  <md-icon slot="start" style={{ color: 'var(--md-sys-color-error)' }}>person_remove</md-icon>
                  <div slot="headline" style={{ color: 'var(--md-sys-color-error)' }}>Remove friend</div>
                </md-list-item>
              </md-list>

              <md-divider role="separator" className="my-2" />

              {/* The full list — a sheet scrolls, so nothing is truncated here. */}
              {friend.docs.length === 0 ? (
                <p className="text-sm text-muted-foreground px-4 py-2">No shared documents</p>
              ) : (
                <md-list style={{ background: 'transparent' }}>
                  {friend.docs.map(d => (
                    <md-list-item key={d.docId} type="link" href={docUrl(d.docId)}>
                      <md-icon slot="start">{iconForType(d.docType)}</md-icon>
                      <div slot="headline">{d.docName}</div>
                      <div slot="supporting-text" className="capitalize">{d.role}</div>
                    </md-list-item>
                  ))}
                </md-list>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
