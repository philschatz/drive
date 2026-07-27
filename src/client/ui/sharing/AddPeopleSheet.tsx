/**
 * Pick who to share a document with: the friends not already on it, plus an
 * "Invite a friend" row that opens the QR exchange. Choosing either leads to
 * the role picker — this sheet never grants access itself.
 */

import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { getFriendName } from '../friend-names';
import type { MemberInfo } from '../../../shared/keyhive-types';

export function AddPeopleSheet({
  open,
  onOpenChange,
  contacts,
  onPick,
  onInvite,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Contacts not already on this document. */
  contacts: MemberInfo[];
  onPick: (contact: MemberInfo) => void;
  onInvite: () => void;
}) {
  // Named contacts first, then alphabetically — an unnamed contact is just an
  // id fragment, so it is the least useful thing to lead with.
  const sorted = [...contacts]
    .map(contact => ({ contact, name: getFriendName(contact.agentId) }))
    .sort((a, b) => {
      if (a.name && !b.name) return -1;
      if (!a.name && b.name) return 1;
      return (a.name || a.contact.agentId).localeCompare(b.name || b.contact.agentId);
    });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85vh] p-4 overflow-y-auto">
        {/* SheetContent doesn't forward extra props — testid goes on a wrapper */}
        <div data-testid="add-people-sheet">
          <SheetHeader>
            <SheetTitle>Add people</SheetTitle>
          </SheetHeader>

          <md-list style={{ background: 'transparent' }} className="mt-2">
            {sorted.map(({ contact, name }) => (
              <md-list-item
                key={contact.agentId}
                type="button"
                data-testid="add-person-row"
                onClick={() => onPick(contact)}
              >
                <md-icon slot="start">person</md-icon>
                <div slot="headline" className={name ? '' : 'text-muted-foreground'} title={contact.agentId}>
                  {name || `${contact.agentId.slice(0, 8)}…`}
                </div>
              </md-list-item>
            ))}

            {/* Always last, and the only row when you have no friends yet. */}
            <md-list-item type="button" data-testid="invite-friend" onClick={onInvite}>
              <md-icon slot="start">person_add</md-icon>
              <div slot="headline">Invite a friend</div>
            </md-list-item>
          </md-list>
        </div>
      </SheetContent>
    </Sheet>
  );
}
