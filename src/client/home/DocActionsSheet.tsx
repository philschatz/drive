/**
 * Per-document actions bottom sheet — opened by long-pressing (or right-clicking,
 * or Shift+F10 on) a Home list row. Offers Share / Rename / Archive /
 * View source; availability follows the user's access level.
 */
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { sourceUrl } from '@/shared/doc-urls';

export interface DocActionsTarget {
  documentId: string;
  name: string;
  type: string;
  /** null = no access / revoked, undefined = not yet checked */
  access?: string | null;
}

interface DocActionsSheetProps {
  /** The doc the sheet acts on; null = closed. */
  entry: DocActionsTarget | null;
  onOpenChange: (open: boolean) => void;
  onShare: (entry: DocActionsTarget) => void;
  onRename: (entry: DocActionsTarget) => void;
  onArchive: (entry: DocActionsTarget) => void;
}

export function DocActionsSheet({ entry, onOpenChange, onShare, onRename, onArchive }: DocActionsSheetProps) {
  // Actions stay visible but disabled when the access level doesn't allow them:
  // sharing is managed by admins; renaming needs edit access.
  const canShare = entry?.access === 'admin';
  const canRename = entry?.access === 'edit' || entry?.access === 'admin';

  // Close the sheet before running the action so follow-up surfaces
  // (share/rename sheets, confirm dialogs) aren't stacked under it.
  const pick = (fn: (e: DocActionsTarget) => void) => () => {
    const e = entry!;
    onOpenChange(false);
    fn(e);
  };

  return (
    <Sheet open={!!entry} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[70vh] p-4">
        <SheetHeader>
          <SheetTitle className="truncate pr-8">{entry?.name || 'Untitled'}</SheetTitle>
        </SheetHeader>
        <md-list style={{ background: 'transparent' }} className="mt-2">
          <md-list-item type="button" disabled={!canShare} onClick={canShare ? pick(onShare) : undefined}>
            <md-icon slot="start">share</md-icon>
            <div slot="headline">Share</div>
          </md-list-item>
          <md-list-item type="button" disabled={!canRename} onClick={canRename ? pick(onRename) : undefined}>
            <md-icon slot="start">edit</md-icon>
            <div slot="headline">Rename</div>
          </md-list-item>
          <md-list-item type="button" onClick={pick(onArchive)}>
            <md-icon slot="start">archive</md-icon>
            <div slot="headline">Archive</div>
          </md-list-item>
          <md-divider role="separator" />
          {entry && (
            <md-list-item type="link" href={sourceUrl(entry.documentId)}>
              <md-icon slot="start">code</md-icon>
              <div slot="headline">View source</div>
            </md-list-item>
          )}
        </md-list>
      </SheetContent>
    </Sheet>
  );
}
