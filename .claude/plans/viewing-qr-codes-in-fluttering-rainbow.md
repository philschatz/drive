# Fix QR viewing + friend-add flow

## Context

Four related regressions/requests around the contact + QR sharing flow:

1. **QR codes "gone" in Settings.** Root cause confirmed: the share/link **URL is too long to fit in a QR code**. The contact card bundles `groupEvents` — the full union of the individual's + user-group's keyhive ops ([keyhive-ops.ts:369-386](src/client/keyhive-ops.ts#L369)) — which grows with account/membership history. A real mixed-case base64url URL forces QR **byte mode** (cap ≈ 2331 chars at the default ECC level "M"), so once the payload is large enough `QRCode.toString` throws *"The amount of data is too big to be stored in a QR Code"* (verified: 4000-char URL throws; ~3000 ok). The QR refactor in commit `abcf5b0` then routes that throw into `QRCodeDisplay`'s `.catch(() => {})`, which returns `null` — so there is no QR, no error, no console output. The `qrcode` library itself works for short URLs (verified in Node); the silent catch on a too-big payload is what makes it "seem gone."

   **On compression:** it is *already applied* — both URL builders deflate (pako) + base64url-encode the payload ([encodeCardForUrl](src/client/settings/AddFriendPage.tsx#L41), [LinkDevicePage.tsx:44](src/client/settings/LinkDevicePage.tsx#L44)). The payload is over the cap *even compressed*, so the fix is error-correction headroom + a graceful fallback (and optionally trimming the embedded ops), not adding compression.
2. **Contact list shows "BUG".** [Contacts.tsx:64](src/client/contacts/Contacts.tsx#L64) does `throw new Error('BUG')` when a doc member is not a `group`, even though the comment directly above says to *skip* such members (unrevoked invite temp identities). One non-group member crashes the entire Contacts page into its error alert.
3. **Adding a friend via the UI doesn't actually add them (tests pass).** Contacts only surfaces people who are (a) members of an already-shared doc, or (b) have a saved contact-name. A freshly added friend is neither. The Playwright scenarios pass only because they immediately share a document ([tests-pw/support/scenarios.ts](src/client/tests-pw/support/scenarios.ts)). The share panel ([AccessControl.tsx:130](src/client/components/AccessControl.tsx#L130)) already shows received friends via `getKnownContacts()` — the Contacts page just never calls it.
4. **Show a reciprocal QR.** After someone adds a friend, show that user their own friend-QR so the friend can add them back, making the relationship bidirectional.

**Decisions (confirmed with user):** Contacts list uses `getKnownContacts()` as its source of truth while still showing saved display names; the reciprocal QR appears on the Add Friend **success screen**.

## Changes

### 1. Fix QR capacity + stop hiding errors — [src/client/components/ui/qr-code.tsx](src/client/components/ui/qr-code.tsx)

The payload-too-big throw must (a) gain headroom and (b) never be silent again:
- **Add error-correction headroom:** pass `errorCorrectionLevel: 'L'` to `QRCode.toString` (raises byte-mode capacity ~2331 → ~2953 chars, ~27% more) — covers payloads that are just over the default "M" cap.
- **Surface the error:** replace `.catch(() => {})` with a handler that `console.error`s and stores the error in state.
- **Graceful fallback instead of `return null`:** when generation fails (e.g. still too big), render a small visible note — e.g. "Payload too large for a QR code — use the link below." In Settings the link `<input>` is rendered *separately* from `QRCodeDisplay` ([Settings.tsx:271-276](src/client/settings/Settings.tsx#L271), [307-312](src/client/settings/Settings.tsx#L307)) and still works, so the user can always copy the link; the QR box just shouldn't vanish without explanation.
- Keep the existing success path (click-to-copy + `dangerouslySetInnerHTML`) unchanged.

**Optional deeper fix (only if "L" headroom is still not enough for real accounts):** reduce the embedded payload — e.g. revisit whether the full `groupEvents` union in [keyhive-ops.ts getContactCard](src/client/keyhive-ops.ts#L355) must travel in the URL, or fall back to relay-based group sync for oversized bundles. This is riskier (the recipient needs those ops to resolve the group as a share target — see `receiveContactCard`), so treat it as a follow-up gated on the runtime URL lengths observed during verification.

### 2. Fix the "BUG" throw — [src/client/contacts/Contacts.tsx](src/client/contacts/Contacts.tsx)

Change line 64 from `if (m.type !== 'group') throw new Error('BUG');` to `if (m.type !== 'group') continue;` — matching the comment's intent (skip non-group members such as unrevoked invite temp identities). This stops one stray member from crashing the whole list.

### 3. Make Contacts source from `getKnownContacts` — [src/client/contacts/Contacts.tsx](src/client/contacts/Contacts.tsx)

In `refresh()`, mirror the share panel's pattern:
- Add `getKnownContacts('')` (empty/falsy `excludeDocId` ⇒ excludes no doc — see worker handler [automerge-worker.ts:1316-1329](src/client/automerge-worker.ts#L1316)) to the set of calls, using `Promise.allSettled` so a partial failure still renders.
- Seed the `map` with each known contact (all `type: 'group'`, `isGroup: true`, empty `docs`, `deviceIds` from the result) before/while iterating `getDocMembers` results.
- Keep the existing per-doc loop to attach the shared-doc list + roles to each contact entry (with the line-64 `continue` fix).
- Keep the existing `getAllContactNames()` merge (names-only contacts) and `getContactName`-based sorting and `EditableName` display, so saved names still drive labels and ordering.

Reuse the existing `getKnownContacts` wrapper from [worker-api.ts:579](src/client/worker-api.ts#L579) (re-exported via `shared/keyhive-api`); optionally reuse `mergeCachedContacts` from [contact-names.ts](src/client/contact-names.ts) the way AccessControl does. Net effect: a received friend appears immediately (by short id until renamed) without needing a shared doc or a saved name.

### 4. Reciprocal "add me back" QR on success — [src/client/settings/AddFriendPage.tsx](src/client/settings/AddFriendPage.tsx)

On the `saved` success screen (lines 147-159):
- After the contact is added, fetch the current user's own link payload via `getLinkPayload()` (from `shared/keyhive-api`) and build the URL with the existing `buildAddFriendUrl(card, undefined, userGroupId)` already exported from this file.
- Render `QRCodeDisplay` (already-used component) plus a read-only link input and a prompt like "Let them add you back — show them this:".
- Load it lazily (e.g. a `useState` + effect or on reaching the saved state) so it doesn't run before the contact is added. Surface any `getLinkPayload` error via the page's existing `error` state.

No change needed to the `handleSave` Skip path for visibility (issue 3 is solved by `getKnownContacts`); the keyhive ingestion done by `receiveContactCard` already persists the contact.

## Verification

1. `npx tsc -p tsconfig.client.json --noEmit` — frontend typecheck clean.
2. `npm run dev`, open two browser profiles (or use the Playwright harness `window.__drive`):
   - **Settings QR:** open Settings → "Show QR code" / "Show QR Code". Confirm both QR codes render. Temporarily log `url.length` in `QRCodeDisplay` to capture real payload sizes; if any URL still overflows even at ECC "L", the fallback note must show (not a blank box) and the link `<input>` must still be copyable — and that confirms the optional payload-reduction follow-up is warranted.
   - **Add friend:** scan/open the friend QR from profile A in profile B, click **Skip** (no name). Confirm profile B's Contacts page lists profile A (by short id), with **no "BUG"** alert, and **without** sharing any document first.
   - **Reciprocal QR:** confirm the success screen in profile B shows B's own add-me QR + link; open it from profile A and confirm A now lists B.
   - **BUG guard:** confirm Contacts renders even when a doc has a non-group member.
3. `npm run test:pw` — existing peer scenarios still pass.
4. Consider adding a Playwright assertion that a friend added **without** sharing a doc and **without** a name still appears in the Contacts list (reproduces issue 3 before the fix).
