TODO list:

add a show/hide menus button on the right of the toolbar that hides everything above the toolbar to add more space. Also, if all the toolbar butons do not fit, add them into a "..." menu

Update the invite UI to allow inviting existing members to new documents and still allow inviting new people by adding a temporary member that then gets deleted once they rotate keys: swirling-tumbling-kay.md

describe the architecture of the app. Specifically, include the API endpoints between different parts and where there are leaky abstractions

Support users as well as devices. A User is a group while a Device is a leaf node. Then, permissions on a document should be associated with users (groups) and should render the group ID instead of the device ID. Also, when invitations are accepted, replace the temp user with the User (group).
**Limitation:** archive ingestion is limited to individuals, not groups. /home/phil/.claude/plans/rustling-noodling-snowglobe.md

The EditorTitleBar is still sometimes too wide on mobile devices. Combine the admin/write/read icon with the sharing link to save space. Additionally, if the width is narrow, collapse the sharing, history, and source buttons into a dropdown. Too many presence dots cause the rest of the bar to shift off screen. Instead, the presence dots should be collapsed or disappear if the screen is narrow. Consider doing as much as possible using CSS first before relying on javascript.

there is a bug where Bob cannot delete members. Alice creates the document, grants Bob admin, Alice grants Charlie read-only, and then Bob tries to delete Charlie.

is presence information also encrypted through keyhive?

If the Issuer can know the claimers identity when they accept the invite and add their identity to the keyhive graph then add a

Eventually, move the hyperformula evaluation into the worker too, make the UI smart enough to only request visible cells (using the row and column ids)

when linking a device, allow setting a custom name. By default include the operating system and browser

actually, implement things in such a way that adding a device does not require adding the device to all documents. Instead, all documents should have a group representing the user so adding a device should just add it to the group instead of adding it to all the documents. That way, if the user is added to other documents by another process, the device has access to those documents too

temporarily remove filtering the doc list by access level. I am curious what happens when a doc attempts to load

Move source editor validation errors and history navigation to be the same as all the other editors

Support pinning rows/columns, hiding rows/columns, changing the width of rows/columns with a popup prompt. Each of these should have a context menu, a menu bar menu, extra validation (that if there is a row/column freeze and that's a field on the row(s)/column(s) then all rows/columns have that frozen flag, not just the last row/column). Also, hide hidden rows and columns. Labeling should skip if there are hidden ones. Ideally place an unhide/expand button where rows or columns are skipped

BUG: If an admin user deletes the doc (revokes their access) and someone adds them back in, their edits do not show up but should. Also, they do not seem to see that they have regained permissions (a generic share link is present on the top bar instead of their role)

In keyhive, a user should be able to remove themselves from any group or document. Make any necessary updates to keyhive too.

Store pending sync messages on the server. This might require deep changes to automerge-repo to keep track of which document changes have been seen by different users. Also, PWA's support VAPID Push notifications which might be a useful way to send updates when both clients are not online at the same time: https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Tutorials/js13kGames/Re-engageable_Notifications_Push

Build a texas hold'em game and then other P2P board games: https://github.com/predatorray/mental-poker-toolkit
