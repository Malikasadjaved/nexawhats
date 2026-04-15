export type { GroupMetadata, GroupParticipant, ParticipantAction } from './types.js';

/**
 * Group management operations.
 *
 * Will be fully implemented in Phase 6 when we fork Baileys' groups module.
 * The interface is defined here for type safety.
 */
export interface GroupOperations {
  /** Create a new group */
  groupCreate(subject: string, participants: string[]): Promise<{ id: string; subject: string }>;

  /** Get group metadata */
  groupMetadata(jid: string): Promise<import('./types.js').GroupMetadata>;

  /** Update group subject (name) */
  groupUpdateSubject(jid: string, subject: string): Promise<void>;

  /** Update group description */
  groupUpdateDescription(jid: string, description: string): Promise<void>;

  /** Add/remove/promote/demote participants */
  groupParticipantsUpdate(
    jid: string,
    participants: string[],
    action: import('./types.js').ParticipantAction,
  ): Promise<Array<{ jid: string; status: string }>>;

  /** Leave a group */
  groupLeave(jid: string): Promise<void>;

  /** Get invite code */
  groupInviteCode(jid: string): Promise<string>;

  /** Revoke invite code */
  groupRevokeInvite(jid: string): Promise<string>;

  /** Get all groups the bot is part of */
  groupFetchAllParticipating(): Promise<Record<string, import('./types.js').GroupMetadata>>;
}
