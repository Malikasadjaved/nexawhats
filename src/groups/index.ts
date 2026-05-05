/**
 * Group operations — create, join, leave, and manage WhatsApp groups.
 *
 * All group operations follow the same pattern: build an
 * `<iq type="get|set" xmlns="w:g2">` node, send via query(), and parse
 * the response. A single `groupQuery()` helper serves all operations.
 *
 * Ported from Baileys' `Socket/groups.js`.
 */
import {
  getBinaryNodeChild,
  getBinaryNodeChildString,
  getBinaryNodeChildren,
} from '../binary/index.js';
import type { BinaryNode } from '../binary/index.js';
import { isLidUser, isPnUser, jidEncode, jidNormalizedUser } from '../binary/jid.js';
import type {
  GroupAction,
  GroupMemberAddMode,
  GroupMetadataFull,
  GroupRequestAction,
  GroupSetting,
} from '../types/group.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface GroupOperationsConfig {
  /** IQ query function — sends a stanza and returns the response. */
  query: (node: BinaryNode) => Promise<BinaryNode>;
}

export interface GroupOperations {
  groupMetadata(jid: string): Promise<GroupMetadataFull>;
  groupCreate(subject: string, participants: string[]): Promise<GroupMetadataFull>;
  groupLeave(jid: string): Promise<void>;
  groupUpdateSubject(jid: string, subject: string): Promise<void>;
  groupUpdateDescription(jid: string, description?: string): Promise<void>;
  groupParticipantsUpdate(
    jid: string,
    participants: string[],
    action: GroupAction,
  ): Promise<Array<{ status: string; jid: string }>>;
  groupRequestParticipantsList(jid: string): Promise<Array<Record<string, string>>>;
  groupRequestParticipantsUpdate(
    jid: string,
    participants: string[],
    action: GroupRequestAction,
  ): Promise<Array<{ status: string; jid: string }>>;
  groupInviteCode(jid: string): Promise<string | undefined>;
  groupRevokeInvite(jid: string): Promise<string | undefined>;
  groupAcceptInvite(code: string): Promise<string | undefined>;
  groupGetInviteInfo(code: string): Promise<GroupMetadataFull>;
  groupToggleEphemeral(jid: string, ephemeralExpiration: number): Promise<void>;
  groupSettingUpdate(jid: string, setting: GroupSetting): Promise<void>;
  groupMemberAddMode(jid: string, mode: GroupMemberAddMode): Promise<void>;
  groupJoinApprovalMode(jid: string, mode: 'on' | 'off'): Promise<void>;
  groupFetchAllParticipating(): Promise<Record<string, GroupMetadataFull>>;
}

// ── Factory ────────────────────────────────────────────────────────────

export function makeGroupOperations(config: GroupOperationsConfig): GroupOperations {
  const { query } = config;

  /**
   * Send an IQ query for a group operation.
   * All group operations follow:
   * `<iq type="get|set" xmlns="w:g2" to={jid}> <content/> </iq>`
   */
  async function groupQuery(
    jid: string,
    type: 'get' | 'set',
    content: BinaryNode[],
  ): Promise<BinaryNode> {
    return query({
      tag: 'iq',
      attrs: { type, xmlns: 'w:g2', to: jid },
      content,
    });
  }

  /** Fetch full metadata for a group. */
  async function groupMetadata(jid: string): Promise<GroupMetadataFull> {
    const result = await groupQuery(jid, 'get', [
      { tag: 'query', attrs: { request: 'interactive' } },
    ]);
    return extractGroupMetadata(result);
  }

  /** Create a new group. */
  async function groupCreate(subject: string, participants: string[]): Promise<GroupMetadataFull> {
    const key = generateGroupKey();
    const result = await groupQuery('@g.us', 'set', [
      {
        tag: 'create',
        attrs: { subject, key },
        content: participants.map((jid) => ({
          tag: 'participant' as const,
          attrs: { jid },
        })),
      },
    ]);
    return extractGroupMetadata(result);
  }

  /** Leave a group. */
  async function groupLeave(jid: string): Promise<void> {
    await groupQuery('@g.us', 'set', [
      {
        tag: 'leave',
        attrs: {},
        content: [{ tag: 'group', attrs: { id: jid } }],
      },
    ]);
  }

  /** Update a group's subject (name). */
  async function groupUpdateSubject(jid: string, subject: string): Promise<void> {
    await groupQuery(jid, 'set', [
      {
        tag: 'subject',
        attrs: {},
        content: Buffer.from(subject, 'utf-8'),
      },
    ]);
  }

  /** Update or remove a group's description. */
  async function groupUpdateDescription(jid: string, description?: string): Promise<void> {
    const metadata = await groupMetadata(jid);
    const prev = metadata.descId ?? undefined;
    const attrs: Record<string, string> = prev ? { prev } : {};
    if (description) {
      attrs.id = generateGroupKey();
    } else {
      attrs.delete = 'true';
    }
    await groupQuery(jid, 'set', [
      {
        tag: 'description',
        attrs,
        content: description
          ? [{ tag: 'body', attrs: {}, content: Buffer.from(description, 'utf-8') }]
          : undefined,
      },
    ]);
  }

  /** Add, remove, promote, or demote participants. */
  async function groupParticipantsUpdate(
    jid: string,
    participants: string[],
    action: GroupAction,
  ): Promise<Array<{ status: string; jid: string }>> {
    const result = await groupQuery(jid, 'set', [
      {
        tag: action,
        attrs: {},
        content: participants.map((jid) => ({
          tag: 'participant' as const,
          attrs: { jid },
        })),
      },
    ]);
    const node = getBinaryNodeChild(result, action);
    const affected = node ? getBinaryNodeChildren(node, 'participant') : [];
    return affected.map((p) => ({
      status: (p.attrs.error as string) || '200',
      jid: p.attrs.jid as string,
    }));
  }

  /** List pending membership approval requests. */
  async function groupRequestParticipantsList(jid: string): Promise<Array<Record<string, string>>> {
    const result = await groupQuery(jid, 'get', [
      { tag: 'membership_approval_requests', attrs: {} },
    ]);
    const node = getBinaryNodeChild(result, 'membership_approval_requests');
    const participants = node ? getBinaryNodeChildren(node, 'membership_approval_request') : [];
    return participants.map((v) => v.attrs as Record<string, string>);
  }

  /** Approve or reject membership requests. */
  async function groupRequestParticipantsUpdate(
    jid: string,
    participants: string[],
    action: GroupRequestAction,
  ): Promise<Array<{ status: string; jid: string }>> {
    const result = await groupQuery(jid, 'set', [
      {
        tag: 'membership_requests_action',
        attrs: {},
        content: [
          {
            tag: action,
            attrs: {},
            content: participants.map((jid) => ({
              tag: 'participant' as const,
              attrs: { jid },
            })),
          },
        ],
      },
    ]);
    const node = getBinaryNodeChild(result, 'membership_requests_action');
    const nodeAction = node ? getBinaryNodeChild(node, action) : undefined;
    const affected = nodeAction ? getBinaryNodeChildren(nodeAction, 'participant') : [];
    return affected.map((p) => ({
      status: (p.attrs.error as string) || '200',
      jid: p.attrs.jid as string,
    }));
  }

  /** Get the current invite code for a group. */
  async function groupInviteCode(jid: string): Promise<string | undefined> {
    const result = await groupQuery(jid, 'get', [{ tag: 'invite', attrs: {} }]);
    const inviteNode = getBinaryNodeChild(result, 'invite');
    return inviteNode?.attrs.code as string | undefined;
  }

  /** Revoke and retrieve a new invite code. */
  async function groupRevokeInvite(jid: string): Promise<string | undefined> {
    const result = await groupQuery(jid, 'set', [{ tag: 'invite', attrs: {} }]);
    const inviteNode = getBinaryNodeChild(result, 'invite');
    return inviteNode?.attrs.code as string | undefined;
  }

  /** Accept an invite by code. Returns the group JID. */
  async function groupAcceptInvite(code: string): Promise<string | undefined> {
    const results = await groupQuery('@g.us', 'set', [{ tag: 'invite', attrs: { code } }]);
    const groupNode = getBinaryNodeChild(results, 'group');
    return groupNode?.attrs.jid as string | undefined;
  }

  /** Get group metadata via invite code (preview before joining). */
  async function groupGetInviteInfo(code: string): Promise<GroupMetadataFull> {
    const results = await groupQuery('@g.us', 'get', [{ tag: 'invite', attrs: { code } }]);
    return extractGroupMetadata(results);
  }

  /** Set a group's disappearing message expiration (0 to disable). */
  async function groupToggleEphemeral(jid: string, ephemeralExpiration: number): Promise<void> {
    const content: BinaryNode = ephemeralExpiration
      ? {
          tag: 'ephemeral',
          attrs: { expiration: ephemeralExpiration.toString() },
        }
      : { tag: 'not_ephemeral', attrs: {} };
    await groupQuery(jid, 'set', [content]);
  }

  /** Toggle a group setting (announcement, locked, etc.). */
  async function groupSettingUpdate(jid: string, setting: GroupSetting): Promise<void> {
    await groupQuery(jid, 'set', [{ tag: setting, attrs: {} }]);
  }

  /** Set the member add mode (all_member_add or admin_add). */
  async function groupMemberAddMode(jid: string, mode: GroupMemberAddMode): Promise<void> {
    await groupQuery(jid, 'set', [
      {
        tag: 'member_add_mode',
        attrs: {},
        content: mode,
      },
    ]);
  }

  /** Set join approval mode. */
  async function groupJoinApprovalMode(jid: string, mode: 'on' | 'off'): Promise<void> {
    await groupQuery(jid, 'set', [
      {
        tag: 'membership_approval_mode',
        attrs: {},
        content: [{ tag: 'group_join', attrs: { state: mode } }],
      },
    ]);
  }

  /** Fetch all groups the user participates in. */
  async function groupFetchAllParticipating(): Promise<Record<string, GroupMetadataFull>> {
    const result = await query({
      tag: 'iq',
      attrs: {
        to: '@g.us',
        xmlns: 'w:g2',
        type: 'get',
      },
      content: [
        {
          tag: 'participating',
          attrs: {},
          content: [
            { tag: 'participants', attrs: {} },
            { tag: 'description', attrs: {} },
          ],
        },
      ],
    });

    const data: Record<string, GroupMetadataFull> = {};
    const groupsChild = getBinaryNodeChild(result, 'groups');
    if (groupsChild) {
      const groups = getBinaryNodeChildren(groupsChild, 'group');
      for (const groupNode of groups) {
        const meta = extractGroupMetadata({
          tag: 'result',
          attrs: {},
          content: [groupNode],
        });
        data[meta.id] = meta;
      }
    }
    return data;
  }

  return {
    groupMetadata,
    groupCreate,
    groupLeave,
    groupUpdateSubject,
    groupUpdateDescription,
    groupParticipantsUpdate,
    groupRequestParticipantsList,
    groupRequestParticipantsUpdate,
    groupInviteCode,
    groupRevokeInvite,
    groupAcceptInvite,
    groupGetInviteInfo,
    groupToggleEphemeral,
    groupSettingUpdate,
    groupMemberAddMode,
    groupJoinApprovalMode,
    groupFetchAllParticipating,
  };
}

// ── Metadata extraction ────────────────────────────────────────────────

/**
 * Parse a group IQ response into `GroupMetadataFull`.
 * Extracted as a standalone function for independent testing.
 */
export function extractGroupMetadata(result: BinaryNode): GroupMetadataFull {
  const group = getBinaryNodeChild(result, 'group');
  if (!group) {
    throw new Error('No group node in result');
  }

  const descChild = getBinaryNodeChild(group, 'description');
  let desc: string | undefined;
  let descId: string | undefined;
  let descOwner: string | undefined;
  let descOwnerPn: string | undefined;
  let descTime: number | undefined;

  if (descChild) {
    desc = getBinaryNodeChildString(descChild, 'body');
    descOwner = descChild.attrs.participant
      ? jidNormalizedUser(descChild.attrs.participant as string)
      : undefined;
    descOwnerPn = descChild.attrs.participant_pn
      ? jidNormalizedUser(descChild.attrs.participant_pn as string)
      : undefined;
    descTime = Number(descChild.attrs.t) || undefined;
    descId = descChild.attrs.id as string | undefined;
  }

  const groupId = group.attrs.id?.includes('@')
    ? (group.attrs.id as string)
    : jidEncode(group.attrs.id as string, 'g.us');

  const eph = getBinaryNodeChild(group, 'ephemeral')?.attrs.expiration;

  return {
    id: groupId,
    notify: group.attrs.notify as string | undefined,
    subject: group.attrs.subject as string,
    subjectOwner: group.attrs.s_o as string | undefined,
    subjectOwnerPn: group.attrs.s_o_pn as string | undefined,
    subjectTime: Number(group.attrs.s_t) || undefined,
    size: group.attrs.size
      ? Number(group.attrs.size)
      : getBinaryNodeChildren(group, 'participant').length,
    creation: Number(group.attrs.creation) || undefined,
    owner: group.attrs.creator ? jidNormalizedUser(group.attrs.creator as string) : undefined,
    ownerPn: group.attrs.creator_pn
      ? jidNormalizedUser(group.attrs.creator_pn as string)
      : undefined,
    desc,
    descId,
    descOwner,
    descOwnerPn,
    descTime,
    linkedParent: getBinaryNodeChild(group, 'linked_parent')?.attrs.jid as string | undefined,
    restrict: !!getBinaryNodeChild(group, 'locked'),
    announce: !!getBinaryNodeChild(group, 'announcement'),
    isCommunity: !!getBinaryNodeChild(group, 'parent'),
    isCommunityAnnounce: !!getBinaryNodeChild(group, 'default_sub_group'),
    joinApprovalMode: !!getBinaryNodeChild(group, 'membership_approval_mode'),
    memberAddMode:
      getBinaryNodeChildString(group, 'member_add_mode') === 'all_member_add'
        ? 'all_member_add'
        : 'admin_add',
    participants: getBinaryNodeChildren(group, 'participant').map(({ attrs }) => ({
      id: attrs.jid as string,
      phoneNumber:
        isLidUser(attrs.jid as string) && isPnUser(attrs.phone_number as string)
          ? (attrs.phone_number as string)
          : undefined,
      lid:
        isPnUser(attrs.jid as string) && isLidUser(attrs.lid as string)
          ? (attrs.lid as string)
          : undefined,
      isAdmin: (attrs.type as string) === 'admin',
      isSuperAdmin: (attrs.type as string) === 'superadmin',
    })),
    ephemeralDuration: eph ? Number(eph) : undefined,
  };
}

/** Generate a unique key for group operations. */
function generateGroupKey(): string {
  const ts = BigInt(Math.floor(Date.now() / 1000));
  let r = 0n;
  for (let i = 0; i < 10; i++) {
    r = (r << 8n) | BigInt(Math.floor(Math.random() * 256));
  }
  return `${ts.toString(36)}.${r.toString(36)}`;
}
