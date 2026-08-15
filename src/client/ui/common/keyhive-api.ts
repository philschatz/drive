// Thin re-export facade — new code should import from '../worker-api' directly.
export {
  onKeyhiveStateChanged,
  getIdentity,
  getContactCard,
  getKnownFriends,
  getDocMembers,
  getMyAccess,
  rendezvousCreateShare,
  rendezvousReceive,
  rendezvousCreateDeviceLink,
  rendezvousJoinDeviceLink,
  rendezvousCancel,
  onRendezvousEvent,
  listDevices,
  removeDevice,
  changeDeviceRole,
  ensureUserGroup,
  addMember,
  revokeMember,
  changeRole,
} from '../worker-api';
export type { DeviceInfo, IdentityInfo, MemberInfo } from '../worker-api';
