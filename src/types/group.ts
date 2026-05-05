/** Group participant action types for IQ stanzas. */
export type GroupAction = 'add' | 'remove' | 'promote' | 'demote';

/** Group membership request action. */
export type GroupRequestAction = 'approve' | 'reject';

/** Group settings that can be toggled. */
export type GroupSetting =
  | 'announcement'
  | 'locked'
  | 'not_ephemeral'
  | 'ephemeral'
  | 'parent_default_membership_approval_mode';

/** Group member add mode. */
export type GroupMemberAddMode = 'all_member_add' | 'admin_add';

/** Group join approval mode. */
export type GroupJoinApprovalMode = 'on' | 'off';

/** Full group metadata (matches Baileys' extractGroupMetadata output). */
export interface GroupMetadataFull {
  id: string;
  subject: string;
  subjectOwner?: string;
  subjectOwnerPn?: string;
  subjectTime?: number;
  size?: number;
  creation?: number;
  owner?: string;
  ownerPn?: string;
  desc?: string;
  descId?: string;
  descOwner?: string;
  descOwnerPn?: string;
  descTime?: number;
  notify?: string;
  addressingMode?: string;
  linkedParent?: string;
  restrict?: boolean;
  announce?: boolean;
  isCommunity?: boolean;
  isCommunityAnnounce?: boolean;
  joinApprovalMode?: boolean;
  memberAddMode?: GroupMemberAddMode;
  participants: Array<{
    id: string;
    lid?: string;
    phoneNumber?: string;
    isAdmin?: boolean;
    isSuperAdmin?: boolean;
  }>;
  ephemeralDuration?: number;
}

/** Group invite info returned by invite code lookup. */
export interface GroupInviteInfo {
  id: string;
  subject: string;
  subjectOwner: string;
  creation: number;
  size: number;
  isCommunity?: boolean;
  isCommunityAnnounce?: boolean;
  ephemeral?: number;
}

/** Media connection info for uploads. */
export interface MediaConnInfo {
  hosts: Array<{ hostname: string }>;
  auth: string;
  ttl: number;
  maxBuckets: number;
  fetchDate: Date;
}
