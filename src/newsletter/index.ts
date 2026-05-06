/**
 * Newsletter operations — create, manage, and interact with WhatsApp
 * newsletters (channels).
 *
 * Ported from Baileys' `Socket/newsletter.js` + `Socket/mex.js`.
 */
import { S_WHATSAPP_NET, getBinaryNodeChild } from '../binary/index.js';
import type { BinaryNode } from '../binary/index.js';
import { generateMessageId } from '../utils/crypto.js';

// ── Types ──────────────────────────────────────────────────────────────

export type NewsletterViewRole = 'ADMIN' | 'GUEST' | 'OWNER' | 'SUBSCRIBER';

export interface NewsletterMetadata {
  id: string;
  owner?: string;
  name: string;
  description?: string;
  invite?: string;
  creation_time?: number;
  subscribers?: number;
  picture?: {
    url?: string;
    directPath?: string;
    mediaKey?: string;
    id?: string;
  };
  verification?: 'VERIFIED' | 'UNVERIFIED';
  reaction_codes?: Array<{ code: string; count: number }>;
  mute_state?: 'ON' | 'OFF';
  thread_metadata?: {
    creation_time?: number;
    name?: string;
    description?: string;
  };
}

export interface NewsletterCreateResult {
  id: string;
  name: string;
  creation_time: number;
  description?: string;
  invite?: string;
  subscribers: number;
  verification?: string;
  picture?: { id: string; directPath?: string };
  mute_state?: string;
}

export interface NewsletterUpdate {
  name?: string;
  description?: string;
  picture?: string;
}

export interface NewsletterSocket {
  newsletterCreate: (name: string, description?: string) => Promise<NewsletterCreateResult>;
  newsletterUpdateName: (jid: string, name: string) => Promise<unknown>;
  newsletterUpdateDescription: (jid: string, description: string) => Promise<unknown>;
  newsletterUpdatePicture: (jid: string, pictureBase64: string) => Promise<unknown>;
  newsletterRemovePicture: (jid: string) => Promise<unknown>;
  newsletterDelete: (jid: string) => Promise<void>;
  newsletterFollow: (jid: string) => Promise<unknown>;
  newsletterUnfollow: (jid: string) => Promise<unknown>;
  newsletterMute: (jid: string) => Promise<unknown>;
  newsletterUnmute: (jid: string) => Promise<unknown>;
  newsletterSubscribers: (jid: string) => Promise<unknown>;
  newsletterMetadata: (type: 'invite' | 'jid', key: string) => Promise<NewsletterMetadata | null>;
  newsletterReactMessage: (jid: string, serverId: string, reaction?: string) => Promise<void>;
  newsletterFetchMessages: (
    jid: string,
    count: number,
    since?: number,
    after?: string,
  ) => Promise<BinaryNode>;
  subscribeNewsletterUpdates: (jid: string) => Promise<{ duration: string } | null>;
  newsletterAdminCount: (jid: string) => Promise<number>;
  newsletterChangeOwner: (jid: string, newOwnerJid: string) => Promise<void>;
  newsletterDemote: (jid: string, userJid: string) => Promise<void>;
}

export interface NewsletterSocketConfig {
  query: (node: BinaryNode) => Promise<BinaryNode>;
  /** Send a message-level stanza. */
  sendNode?: (node: BinaryNode) => Promise<void>;
  /** Generate a unique message tag for IQ stanzas. */
  generateMessageTag?: () => string;
}

// ── GraphQL Query IDs ──────────────────────────────────────────────────

const QueryIds = {
  CREATE: '8823471724422422',
  UPDATE_METADATA: '24250201037901610',
  METADATA: '6563316087068696',
  SUBSCRIBERS: '9783111038412085',
  FOLLOW: '7871414976211147',
  UNFOLLOW: '7238632346214362',
  MUTE: '29766401636284406',
  UNMUTE: '9864994326891137',
  ADMIN_COUNT: '7130823597031706',
  CHANGE_OWNER: '7341777602580933',
  DEMOTE: '6551828931592903',
  DELETE: '30062808666639665',
} as const;

const XWAPaths = {
  CREATE: 'xwa2_newsletter_create',
  SUBSCRIBERS: 'xwa2_newsletter_subscribers',
  METADATA: 'xwa2_newsletter',
  ADMIN_COUNT: 'xwa2_newsletter_admin',
  MUTE: 'xwa2_newsletter_mute_v2',
  UNMUTE: 'xwa2_newsletter_unmute_v2',
  FOLLOW: 'xwa2_newsletter_follow',
  UNFOLLOW: 'xwa2_newsletter_unfollow',
  CHANGE_OWNER: 'xwa2_newsletter_change_owner',
  DEMOTE: 'xwa2_newsletter_demote',
  DELETE: 'xwa2_newsletter_delete_v2',
  UPDATE: 'xwa2_newsletter_update',
} as const;

// ── Internal helpers ───────────────────────────────────────────────────

function parseNewsletterCreateResponse(response: Record<string, unknown>): NewsletterCreateResult {
  const { id, thread_metadata: thread, viewer_metadata: viewer } = response;
  const t = thread as Record<string, unknown> | undefined;
  const v = viewer as Record<string, unknown> | undefined;
  const name = (t?.name as { text?: string })?.text ?? '';
  const desc = (t?.description as { text?: string })?.text ?? '';
  const picture = t?.picture as { id?: string; direct_path?: string } | undefined;

  return {
    id: id as string,
    name,
    creation_time: Number.parseInt((t?.creation_time as string) ?? '0', 10),
    description: desc || undefined,
    invite: t?.invite as string | undefined,
    subscribers: Number.parseInt((t?.subscribers_count as string) ?? '0', 10),
    verification: t?.verification as string | undefined,
    picture: picture ? { id: picture.id ?? '', directPath: picture.direct_path } : undefined,
    mute_state: v?.mute as string | undefined,
  };
}

function parseNewsletterMetadata(result: unknown): NewsletterMetadata | null {
  if (typeof result !== 'object' || result === null) return null;
  if ('id' in result && typeof (result as Record<string, unknown>).id === 'string') {
    return result as unknown as NewsletterMetadata;
  }
  if (
    'result' in result &&
    typeof (result as Record<string, unknown>).result === 'object' &&
    (result as Record<string, unknown>).result !== null &&
    'id' in ((result as Record<string, unknown>).result as Record<string, unknown>)
  ) {
    return (result as { result: NewsletterMetadata }).result;
  }
  return null;
}

// ── Factory ────────────────────────────────────────────────────────────

export function makeNewsletterSocket(config: NewsletterSocketConfig): NewsletterSocket {
  const { query, sendNode, generateMessageTag } = config;
  const tag = generateMessageTag ?? generateMessageId;

  /**
   * Execute a WhatsApp Mex (GraphQL) query.
   *
   * These use a special IQ stanza (`w:mex`) carrying a JSON-encoded
   * GraphQL variables object and a Facebook-style query ID.
   */
  async function executeWMexQuery(
    variables: Record<string, unknown>,
    queryId: string,
    dataPath: string,
  ): Promise<Record<string, unknown>> {
    const result = await query({
      tag: 'iq',
      attrs: {
        id: tag(),
        type: 'get',
        to: S_WHATSAPP_NET,
        xmlns: 'w:mex',
      },
      content: [
        {
          tag: 'query',
          attrs: { query_id: queryId },
          content: Buffer.from(JSON.stringify({ variables }), 'utf-8'),
        },
      ],
    });

    const child = getBinaryNodeChild(result, 'result');
    if (child?.content) {
      const data = JSON.parse(child.content.toString());
      if (data.errors && data.errors.length > 0) {
        const errorMessages = data.errors
          .map((err: { message?: string }) => err.message || 'Unknown error')
          .join(', ');
        const firstError = data.errors[0];
        const errorCode = firstError.extensions?.error_code || 400;
        throw Object.assign(new Error(`Newsletter API error: ${errorMessages}`), {
          statusCode: errorCode,
          data: firstError,
        });
      }
      const response = dataPath ? data?.data?.[dataPath] : data?.data;
      if (typeof response !== 'undefined') {
        return response as Record<string, unknown>;
      }
    }

    const action = dataPath.startsWith('xwa2_') ? dataPath.slice(5).replace(/_/g, ' ') : dataPath;
    throw Object.assign(new Error(`Failed to ${action}, unexpected response structure`), {
      statusCode: 400,
      data: result,
    });
  }

  /** Internal: apply newsletter metadata updates. */
  async function newsletterUpdate(jid: string, updates: NewsletterUpdate): Promise<unknown> {
    const variables = {
      newsletter_id: jid,
      updates: {
        ...updates,
        settings: null,
      },
    };
    return executeWMexQuery(variables, QueryIds.UPDATE_METADATA, XWAPaths.UPDATE);
  }

  return {
    // ── Create ────────────────────────────────────────────────────
    async newsletterCreate(name: string, description?: string) {
      const variables = {
        input: {
          name,
          description: description ?? null,
        },
      };
      const rawResponse = await executeWMexQuery(variables, QueryIds.CREATE, XWAPaths.CREATE);
      return parseNewsletterCreateResponse(rawResponse);
    },

    // ── Update metadata ───────────────────────────────────────────
    newsletterUpdateName(jid: string, name: string) {
      return newsletterUpdate(jid, { name });
    },

    newsletterUpdateDescription(jid: string, description: string) {
      return newsletterUpdate(jid, { description });
    },

    newsletterUpdatePicture(jid: string, pictureBase64: string) {
      return newsletterUpdate(jid, { picture: pictureBase64 });
    },

    newsletterRemovePicture(jid: string) {
      return newsletterUpdate(jid, { picture: '' });
    },

    // ── Delete ────────────────────────────────────────────────────
    async newsletterDelete(jid: string) {
      await executeWMexQuery({ newsletter_id: jid }, QueryIds.DELETE, XWAPaths.DELETE);
    },

    // ── Follow / Unfollow ─────────────────────────────────────────
    newsletterFollow(jid: string) {
      return executeWMexQuery({ newsletter_id: jid }, QueryIds.FOLLOW, XWAPaths.FOLLOW);
    },

    newsletterUnfollow(jid: string) {
      return executeWMexQuery({ newsletter_id: jid }, QueryIds.UNFOLLOW, XWAPaths.UNFOLLOW);
    },

    // ── Mute / Unmute ─────────────────────────────────────────────
    newsletterMute(jid: string) {
      return executeWMexQuery({ newsletter_id: jid }, QueryIds.MUTE, XWAPaths.MUTE);
    },

    newsletterUnmute(jid: string) {
      return executeWMexQuery({ newsletter_id: jid }, QueryIds.UNMUTE, XWAPaths.UNMUTE);
    },

    // ── Subscribers ───────────────────────────────────────────────
    newsletterSubscribers(jid: string) {
      return executeWMexQuery({ newsletter_id: jid }, QueryIds.SUBSCRIBERS, XWAPaths.SUBSCRIBERS);
    },

    // ── Metadata ──────────────────────────────────────────────────
    async newsletterMetadata(type: 'invite' | 'jid', key: string) {
      const variables = {
        fetch_creation_time: true,
        fetch_full_image: true,
        fetch_viewer_metadata: true,
        input: {
          key,
          type: type.toUpperCase(),
        },
      };
      const result = await executeWMexQuery(variables, QueryIds.METADATA, XWAPaths.METADATA);
      return parseNewsletterMetadata(result);
    },

    // ── React to message ──────────────────────────────────────────
    async newsletterReactMessage(jid: string, serverId: string, reaction?: string) {
      const node: BinaryNode = {
        tag: 'message',
        attrs: {
          to: jid,
          ...(reaction ? {} : { edit: '7' }),
          type: 'reaction',
          server_id: serverId,
          id: tag(),
        },
        content: [
          {
            tag: 'reaction',
            attrs: reaction ? { code: reaction } : {},
          },
        ],
      };

      if (sendNode) {
        await sendNode(node);
      } else {
        await query(node);
      }
    },

    // ── Fetch messages ────────────────────────────────────────────
    newsletterFetchMessages(jid: string, count: number, since?: number, after?: string) {
      const messageUpdateAttrs: Record<string, string> = {
        count: count.toString(),
      };
      if (typeof since === 'number') {
        messageUpdateAttrs.since = since.toString();
      }
      if (after) {
        messageUpdateAttrs.after = after;
      }
      return query({
        tag: 'iq',
        attrs: {
          id: tag(),
          type: 'get',
          xmlns: 'newsletter',
          to: jid,
        },
        content: [
          {
            tag: 'message_updates',
            attrs: messageUpdateAttrs,
          },
        ],
      });
    },

    // ── Subscribe updates ────────────────────────────────────────
    async subscribeNewsletterUpdates(jid: string) {
      const result = await query({
        tag: 'iq',
        attrs: {
          id: tag(),
          type: 'set',
          xmlns: 'newsletter',
          to: jid,
        },
        content: [{ tag: 'live_updates', attrs: {}, content: [] }],
      });
      const liveUpdatesNode = getBinaryNodeChild(result, 'live_updates');
      const duration = liveUpdatesNode?.attrs?.duration;
      return duration ? { duration } : null;
    },

    // ── Admin count ──────────────────────────────────────────────
    async newsletterAdminCount(jid: string) {
      const response = await executeWMexQuery(
        { newsletter_id: jid },
        QueryIds.ADMIN_COUNT,
        XWAPaths.ADMIN_COUNT,
      );
      return (response as { admin_count?: number }).admin_count ?? 0;
    },

    // ── Change owner ─────────────────────────────────────────────
    async newsletterChangeOwner(jid: string, newOwnerJid: string) {
      await executeWMexQuery(
        { newsletter_id: jid, user_id: newOwnerJid },
        QueryIds.CHANGE_OWNER,
        XWAPaths.CHANGE_OWNER,
      );
    },

    // ── Demote admin ─────────────────────────────────────────────
    async newsletterDemote(jid: string, userJid: string) {
      await executeWMexQuery(
        { newsletter_id: jid, user_id: userJid },
        QueryIds.DEMOTE,
        XWAPaths.DEMOTE,
      );
    },
  };
}
