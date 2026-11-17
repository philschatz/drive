/**
 * Shared keyhive member/contact types.
 *
 * Defined here (a dependency-free module) rather than in worker-api.ts or
 * keyhive-ops.ts so both the main thread and the worker can import them without
 * pulling in each other's runtime (preact hooks vs. the keyhive WASM bindings).
 */

/** Access level a member has on a document. */
export type MemberRole = 'read' | 'edit' | 'admin';

/**
 * What one of the user's own devices reports for its access, where `null` means
 * "holds no membership" — a device revoked from the user-group, or a device whose
 * group can't be read yet (fresh install, or ops not synced).
 *
 * Deliberately a widening of `MemberRole` rather than an extra `'none'` member of
 * it: `null` is how the rest of the codebase already spells no-access
 * (`getMyAccess`, `getUserGroupAccess`, `accessTitle(null) === 'No access'`), and
 * keeping `MemberRole` at three values is what stops "no access" becoming a thing
 * you can *pick* in RolePickerSheet.
 */
export type DeviceRole = MemberRole | null;

/** One of the user's own devices, as reported by KeyhiveOps.listGroupDevices. */
export interface DeviceEntry {
  agentId: string;
  role: DeviceRole;
  isMe: boolean;
  /**
   * Holds a *root* edge on the group — the device that created the user-group.
   * Every other device's membership descends from it, and a delegation is live
   * only while its issuer has standing: revoking a founder leaves the group with
   * no members at all, for everyone. keyhive itself allows that, so
   * KeyhiveOps.assertManageable refuses it and the UI must not offer to demote
   * or remove a founder.
   */
  isFounder: boolean;
  /**
   * agentId that issued this device's delegation — the device that linked it
   * (for a founder, the group's own key). The UI lets a device manage the ones it
   * linked. Independently, KeyhiveOps refuses to revoke a device that *this*
   * device's own link descends from, since that would revoke this device too.
   * Absent when there is no membership to read.
   */
  issuerAgentId?: string;
}

interface MemberInfoBase {
  agentId: string;
  displayId: string;
  /** Access level for the document. Absent for contacts not yet on any document. */
  role?: MemberRole;
  isMe: boolean;
}

/** A single device (or a temporary invite identity). */
export interface IndividualMemberInfo extends MemberInfoBase {
  type: 'individual';
  /** The base64 id of this device's owning user-group (its share target), if known. */
  groupId?: string;
}

/** A user-group — all of a user's devices, addressed as one share target. */
export interface GroupMemberInfo extends MemberInfoBase {
  type: 'group';
  /** Base64 agent ids of the devices in this group (empty if its ops haven't synced). */
  deviceIds: string[];
}

export type MemberInfo = IndividualMemberInfo | GroupMemberInfo;

/** Outcome of the home-page "archive" action (KeyhiveOps.revokeMyAccess). */
export type ArchiveDocResult = {
  /**
   * 'revoked' — the user-group's access was dropped (the doc leaves every
   * device's home list once the revocation syncs). 'no-authority' — the revoke
   * failed (kept only local: the caller archives/tombstones the doc instead).
   * 'not-found' — keyhive doesn't know the doc.
   */
  status: 'revoked' | 'no-authority' | 'not-found';
  /** Pre-revoke direct-grant signatures for the user-group (re-share detection baseline). */
  grantSigs: string[];
};
