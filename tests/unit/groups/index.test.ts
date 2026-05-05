import { describe, expect, it } from 'vitest';
import type { BinaryNode } from '../../../src/binary/index.js';
import { extractGroupMetadata } from '../../../src/groups/index.js';

// ── Helpers ─────────────────────────────────────────────────────────────

/** Build a minimal group IQ response BinaryNode for testing. */
function makeGroupResult(
  overrides: Partial<{
    id: string;
    subject: string;
    creation: string;
    creator: string;
    size: string;
    participants: Array<{ jid: string; type?: string }>;
    description: { body: string; id: string; participant: string; t: string } | null;
    ephemeral: string | null;
    locked: boolean;
    announcement: boolean;
    memberAddMode: string | null;
    linkedParent: string | null;
    parent: boolean;
    defaultSubGroup: boolean;
    membershipApprovalMode: boolean;
  }> = {},
): BinaryNode {
  const content: BinaryNode[] = [];

  if (overrides.participants?.length) {
    content.push({
      tag: 'participant',
      attrs: overrides.participants[0] ?? {},
      content: undefined,
    });
    for (const p of overrides.participants.slice(1)) {
      content.push({
        tag: 'participant',
        attrs: p,
        content: undefined,
      });
    }
  }

  if (overrides.description) {
    const descContent: BinaryNode[] = [];
    if (overrides.description.body) {
      descContent.push({
        tag: 'body',
        attrs: {},
        content: Buffer.from(overrides.description.body, 'utf-8'),
      });
    }
    content.push({
      tag: 'description',
      attrs: {
        id: overrides.description.id,
        participant: overrides.description.participant,
        t: overrides.description.t,
      },
      content: descContent.length > 0 ? descContent : undefined,
    });
  } else if (overrides.description === null) {
    // Explicitly null means no description node
  }

  if (overrides.ephemeral) {
    content.push({
      tag: 'ephemeral',
      attrs: { expiration: overrides.ephemeral },
    });
  }

  if (overrides.locked) {
    content.push({ tag: 'locked', attrs: {} });
  }

  if (overrides.announcement) {
    content.push({ tag: 'announcement', attrs: {} });
  }

  if (overrides.memberAddMode) {
    content.push({
      tag: 'member_add_mode',
      attrs: {},
      content: overrides.memberAddMode,
    });
  }

  if (overrides.linkedParent) {
    content.push({
      tag: 'linked_parent',
      attrs: { jid: overrides.linkedParent },
    });
  }

  if (overrides.parent) {
    content.push({ tag: 'parent', attrs: {} });
  }

  if (overrides.defaultSubGroup) {
    content.push({ tag: 'default_sub_group', attrs: {} });
  }

  if (overrides.membershipApprovalMode) {
    content.push({ tag: 'membership_approval_mode', attrs: {} });
  }

  const group: BinaryNode = {
    tag: 'group',
    attrs: {
      id: overrides.id ?? '123@g.us',
      subject: overrides.subject ?? 'Test Group',
      creation: overrides.creation ?? '1700000000',
      creator: overrides.creator ?? '456@s.whatsapp.net',
      size: overrides.size ?? '1',
    },
    content: content.length > 0 ? content : undefined,
  };

  return {
    tag: 'iq',
    attrs: { type: 'result', xmlns: 'w:g2' },
    content: [group],
  };
}

// ── extractGroupMetadata ────────────────────────────────────────────────

describe('extractGroupMetadata', () => {
  it('parses a minimal group response', () => {
    const result = makeGroupResult();
    const meta = extractGroupMetadata(result);
    expect(meta.id).toBe('123@g.us');
    expect(meta.subject).toBe('Test Group');
    expect(meta.creation).toBe(1700000000);
    expect(meta.owner).toBe('456@s.whatsapp.net');
    expect(meta.size).toBe(1);
  });

  it('normalizes bare group IDs to @g.us format', () => {
    const result = makeGroupResult({ id: '999' });
    const meta = extractGroupMetadata(result);
    expect(meta.id).toBe('999@g.us');
  });

  it('parses participants', () => {
    const result = makeGroupResult({
      size: '3',
      participants: [
        { jid: '111@s.whatsapp.net', type: 'admin' },
        { jid: '222@s.whatsapp.net' },
        { jid: '333@s.whatsapp.net', type: 'superadmin' },
      ],
    });
    const meta = extractGroupMetadata(result);
    expect(meta.participants).toHaveLength(3);
    expect(meta.participants[0]).toEqual({
      id: '111@s.whatsapp.net',
      isAdmin: true,
      isSuperAdmin: false,
      lid: undefined,
      phoneNumber: undefined,
    });
    expect(meta.participants[2]?.isSuperAdmin).toBe(true);
  });

  it('parses LID/PN participant dual addressing', () => {
    const result = makeGroupResult({
      participants: [
        {
          jid: '111@lid',
          type: 'admin',
        },
      ],
    });
    // Add lid/phone_number attrs — our test helper maps attrs as-is
    const groupNode = result.content?.[0] as BinaryNode;
    if (groupNode.content && Array.isArray(groupNode.content)) {
      const pNode = groupNode.content.find(
        (c) => typeof c === 'object' && c !== null && (c as BinaryNode).tag === 'participant',
      ) as BinaryNode | undefined;
      if (pNode?.attrs) {
        pNode.attrs.phone_number = '111@s.whatsapp.net';
      }
    }
    const meta = extractGroupMetadata(result);
    expect(meta.participants[0]?.phoneNumber).toBe('111@s.whatsapp.net');
  });

  it('parses group description', () => {
    const result = makeGroupResult({
      description: {
        body: 'Welcome to the group!',
        id: 'desc-001',
        participant: '456@s.whatsapp.net',
        t: '1700000001',
      },
    });
    const meta = extractGroupMetadata(result);
    expect(meta.desc).toBe('Welcome to the group!');
    expect(meta.descId).toBe('desc-001');
    expect(meta.descOwner).toBe('456@s.whatsapp.net');
    expect(meta.descTime).toBe(1700000001);
  });

  it('handles groups without description', () => {
    const result = makeGroupResult({ description: null });
    const meta = extractGroupMetadata(result);
    expect(meta.desc).toBeUndefined();
    expect(meta.descId).toBeUndefined();
    expect(meta.descOwner).toBeUndefined();
  });

  it('parses ephemeral duration', () => {
    const result = makeGroupResult({ ephemeral: '86400' });
    const meta = extractGroupMetadata(result);
    expect(meta.ephemeralDuration).toBe(86400);
  });

  it('detects locked group', () => {
    const locked = makeGroupResult({ locked: true });
    const unlocked = makeGroupResult({ locked: false });
    expect(extractGroupMetadata(locked).restrict).toBe(true);
    expect(extractGroupMetadata(unlocked).restrict).toBe(false);
  });

  it('detects announcement-only group', () => {
    const announce = makeGroupResult({ announcement: true });
    expect(extractGroupMetadata(announce).announce).toBe(true);
    expect(extractGroupMetadata(makeGroupResult({})).announce).toBe(false);
  });

  it('detects community parent', () => {
    const community = makeGroupResult({ parent: true });
    expect(extractGroupMetadata(community).isCommunity).toBe(true);
  });

  it('detects community announcement subgroup', () => {
    const announce = makeGroupResult({ defaultSubGroup: true });
    expect(extractGroupMetadata(announce).isCommunityAnnounce).toBe(true);
  });

  it('detects membership approval mode', () => {
    const withApproval = makeGroupResult({ membershipApprovalMode: true });
    expect(extractGroupMetadata(withApproval).joinApprovalMode).toBe(true);
  });

  it('parses member_add_mode', () => {
    const allAdd = makeGroupResult({ memberAddMode: 'all_member_add' });
    const adminAdd = makeGroupResult({ memberAddMode: 'admin_add' });
    expect(extractGroupMetadata(allAdd).memberAddMode).toBe('all_member_add');
    expect(extractGroupMetadata(adminAdd).memberAddMode).toBe('admin_add');
  });

  it('parses linked parent JID', () => {
    const linked = makeGroupResult({ linkedParent: '789@g.us' });
    expect(extractGroupMetadata(linked).linkedParent).toBe('789@g.us');
  });

  it('computes size from participants when size attr is absent', () => {
    const result = makeGroupResult({
      size: '', // empty string is falsy — falls through to participant count
      participants: [
        { jid: 'a@s.whatsapp.net' },
        { jid: 'b@s.whatsapp.net' },
        { jid: 'c@s.whatsapp.net' },
      ],
    });
    const meta = extractGroupMetadata(result);
    expect(meta.size).toBe(3);
  });

  it('normalizes creator/description owner JIDs (strips device, preserves host)', () => {
    // jidNormalizedUser strips device but keeps server — hosted stays hosted
    const result = makeGroupResult({
      creator: '456:10@s.whatsapp.net',
      description: {
        body: 'desc',
        id: 'd1',
        participant: '789:20@s.whatsapp.net',
        t: '1700000001',
      },
    });
    const meta = extractGroupMetadata(result);
    expect(meta.owner).toBe('456@s.whatsapp.net');
    expect(meta.descOwner).toBe('789@s.whatsapp.net');
  });

  it('throws when no group node is present', () => {
    const empty: BinaryNode = {
      tag: 'iq',
      attrs: { type: 'result' },
    };
    expect(() => extractGroupMetadata(empty)).toThrow('No group node');
  });
});
