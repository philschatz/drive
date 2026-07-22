/**
 * Shared keyhive member/contact types.
 *
 * Defined here (a dependency-free module) rather than in worker-api.ts or
 * keyhive-ops.ts so both the main thread and the worker can import them without
 * pulling in each other's runtime (preact hooks vs. the keyhive WASM bindings).
 */

/** Access level a member has on a document. */
export type MemberRole = 'read' | 'edit' | 'admin';

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
