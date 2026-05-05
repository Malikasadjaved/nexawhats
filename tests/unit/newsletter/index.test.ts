import { describe, expect, it } from 'vitest';
import { getBinaryNodeChild, S_WHATSAPP_NET } from '../../../src/binary/index.js';
import type { BinaryNode } from '../../../src/binary/index.js';
import { makeNewsletterSocket } from '../../../src/newsletter/index.js';
import type { NewsletterSocket } from '../../../src/newsletter/index.js';

// ── Helpers ──────────────────────────────────────────────────────────

// Reverse mapping from GraphQL query_id → XWA data path so the mock
// can build a correctly-nested default response for any Mex query.
const QUERY_ID_TO_PATH: Record<string, string> = {
  '8823471724422422': 'xwa2_newsletter_create',
  '24250201037901610': 'xwa2_newsletter_update',
  '6563316087068696': 'xwa2_newsletter',
  '9783111038412085': 'xwa2_newsletter_subscribers',
  '7871414976211147': 'xwa2_newsletter_follow',
  '7238632346214362': 'xwa2_newsletter_unfollow',
  '29766401636284406': 'xwa2_newsletter_mute_v2',
  '9864994326891137': 'xwa2_newsletter_unmute_v2',
  '7130823597031706': 'xwa2_newsletter_admin',
  '7341777602580933': 'xwa2_newsletter_change_owner',
  '6551828931592903': 'xwa2_newsletter_demote',
  '30062808666639665': 'xwa2_newsletter_delete_v2',
};

function createMockQuery(response?: BinaryNode, content?: string) {
  const responses: BinaryNode[] = [];
  return {
    query: async (node: BinaryNode) => {
      responses.push(node);
      if (response) return response;
      // Default: return a basic result node for Mex queries
      if (node.attrs.xmlns === 'w:mex') {
        const queryChild = getBinaryNodeChild(node, 'query');
        const queryId = queryChild?.attrs?.query_id;
        // Build a response with the correct dataPath key so that
        // executeWMexQuery's `data?.data?.[dataPath]` lookup succeeds.
        const defaultContent = (() => {
          if (content) return content;
          const dataPath = queryId ? QUERY_ID_TO_PATH[queryId] : undefined;
          const inner: Record<string, unknown> = {};
          if (dataPath) inner[dataPath] = {};
          return JSON.stringify({ data: inner });
        })();
        return {
          tag: 'iq',
          attrs: { type: 'result', id: node.attrs.id || 'resp' },
          content: [
            {
              tag: 'result',
              attrs: {},
              content: Buffer.from(defaultContent, 'utf-8'),
            },
          ],
        };
      }
      return { tag: 'iq', attrs: { type: 'result', id: node.attrs.id || 'resp' } };
    },
    getResponses: () => responses,
    getLastQuery: () => responses[responses.length - 1],
  };
}

function createSocket(
  response?: BinaryNode,
  content?: string,
): { socket: NewsletterSocket; getResponses: () => BinaryNode[]; getLastQuery: () => BinaryNode | undefined } {
  const mock = createMockQuery(response, content);
  const socket = makeNewsletterSocket({ query: mock.query, sendNode: async () => {} });
  return { socket, ...mock };
}

// ── newsletterCreate ──────────────────────────────────────────────────

describe('newsletterCreate', () => {
  it('sends the correct Mex query for creation', async () => {
    const content = JSON.stringify({
      data: {
        xwa2_newsletter_create: {
          id: '123@newsletter',
          thread_metadata: {
            name: { text: 'My Channel' },
            description: { text: 'A test channel' },
            creation_time: '1700000000',
            subscribers_count: '0',
            verification: 'UNVERIFIED',
            picture: { id: 'pic1', direct_path: '/pic1' },
          },
          viewer_metadata: { mute: 'OFF' },
        },
      },
    });
    const { socket, getLastQuery } = createSocket(undefined, content);

    const result = await socket.newsletterCreate('My Channel', 'A test channel');

    const query = getLastQuery();
    expect(query).toBeDefined();
    expect(query?.tag).toBe('iq');
    expect(query?.attrs.xmlns).toBe('w:mex');
    expect(query?.attrs.to).toBe(S_WHATSAPP_NET);
    expect(result.id).toBe('123@newsletter');
    expect(result.name).toBe('My Channel');
    expect(result.description).toBe('A test channel');
    expect(result.subscribers).toBe(0);
  });

  it('handles missing description gracefully', async () => {
    const content = JSON.stringify({
      data: {
        xwa2_newsletter_create: {
          id: '456@newsletter',
          thread_metadata: {
            name: { text: 'No Desc' },
            description: { text: '' },
            creation_time: '1700000000',
            subscribers_count: '0',
            picture: { id: '', direct_path: '' },
          },
          viewer_metadata: { mute: 'OFF' },
        },
      },
    });
    const { socket } = createSocket(undefined, content);
    const result = await socket.newsletterCreate('No Desc');
    expect(result.id).toBe('456@newsletter');
    expect(result.description).toBeUndefined();
  });
});

// ── newsletterMetadata ───────────────────────────────────────────────

describe('newsletterMetadata', () => {
  it('sends a metadata query with the correct variables', async () => {
    const content = JSON.stringify({
      data: {
        xwa2_newsletter: {
          id: '789@newsletter',
          name: 'My Newsletter',
          description: 'A description',
          subscribers: 42,
          verification: 'VERIFIED',
          mute_state: 'OFF',
        },
      },
    });
    const { socket, getResponses } = createSocket(undefined, content);

    const result = await socket.newsletterMetadata('jid', '789@newsletter');

    const queries = getResponses();
    expect(queries.length).toBeGreaterThan(0);
    const variables = JSON.parse(
      getBinaryNodeChild(queries[0]!, 'query')?.content?.toString() ?? '{}',
    ).variables;
    expect(variables.input.key).toBe('789@newsletter');
    expect(variables.input.type).toBe('JID');
    expect(variables.fetch_viewer_metadata).toBe(true);
    expect(result?.id).toBe('789@newsletter');
    expect(result?.name).toBe('My Newsletter');
    expect(result?.subscribers).toBe(42);
  });

  it('throws when the response lacks the expected data path', async () => {
    const content = JSON.stringify({ data: {} });
    const { socket } = createSocket(undefined, content);
    await expect(
      socket.newsletterMetadata('invite', 'some-invite-code'),
    ).rejects.toThrow('unexpected response structure');
  });
});

// ── newsletterFollow / newsletterUnfollow ────────────────────────────

describe('follow / unfollow', () => {
  it('sends correct follow query', async () => {
    const { socket, getLastQuery } = createSocket();
    await socket.newsletterFollow('nl@newsletter');
    const query = getLastQuery();
    const variables = JSON.parse(
      getBinaryNodeChild(query!, 'query')?.content?.toString() ?? '{}',
    ).variables;
    expect(variables.newsletter_id).toBe('nl@newsletter');
  });

  it('sends correct unfollow query', async () => {
    const { socket, getLastQuery } = createSocket();
    await socket.newsletterUnfollow('nl@newsletter');
    const query = getLastQuery();
    const variables = JSON.parse(
      getBinaryNodeChild(query!, 'query')?.content?.toString() ?? '{}',
    ).variables;
    expect(variables.newsletter_id).toBe('nl@newsletter');
  });
});

// ── newsletterMute / newsletterUnmute ────────────────────────────────

describe('mute / unmute', () => {
  it('sends correct mute query', async () => {
    const { socket, getLastQuery } = createSocket();
    await socket.newsletterMute('nl@newsletter');
    const query = getLastQuery();
    const variables = JSON.parse(
      getBinaryNodeChild(query!, 'query')?.content?.toString() ?? '{}',
    ).variables;
    expect(variables.newsletter_id).toBe('nl@newsletter');
  });

  it('sends correct unmute query', async () => {
    const { socket, getLastQuery } = createSocket();
    await socket.newsletterUnmute('nl@newsletter');
    const query = getLastQuery();
    const variables = JSON.parse(
      getBinaryNodeChild(query!, 'query')?.content?.toString() ?? '{}',
    ).variables;
    expect(variables.newsletter_id).toBe('nl@newsletter');
  });
});

// ── update operations ─────────────────────────────────────────────────

describe('update operations', () => {
  it('newsletterUpdateName sends correct update', async () => {
    const { socket, getLastQuery } = createSocket();
    await socket.newsletterUpdateName('nl@newsletter', 'New Name');
    const query = getLastQuery();
    const variables = JSON.parse(
      getBinaryNodeChild(query!, 'query')?.content?.toString() ?? '{}',
    ).variables;
    expect(variables.newsletter_id).toBe('nl@newsletter');
    expect(variables.updates.name).toBe('New Name');
  });

  it('newsletterUpdateDescription sends correct update', async () => {
    const { socket, getLastQuery } = createSocket();
    await socket.newsletterUpdateDescription('nl@newsletter', 'New Desc');
    const query = getLastQuery();
    const variables = JSON.parse(
      getBinaryNodeChild(query!, 'query')?.content?.toString() ?? '{}',
    ).variables;
    expect(variables.updates.description).toBe('New Desc');
  });

  it('newsletterUpdatePicture sends picture base64 update', async () => {
    const { socket, getLastQuery } = createSocket();
    await socket.newsletterUpdatePicture('nl@newsletter', 'base64picdata');
    const query = getLastQuery();
    const variables = JSON.parse(
      getBinaryNodeChild(query!, 'query')?.content?.toString() ?? '{}',
    ).variables;
    expect(variables.updates.picture).toBe('base64picdata');
  });

  it('newsletterRemovePicture sends empty string picture', async () => {
    const { socket, getLastQuery } = createSocket();
    await socket.newsletterRemovePicture('nl@newsletter');
    const query = getLastQuery();
    const variables = JSON.parse(
      getBinaryNodeChild(query!, 'query')?.content?.toString() ?? '{}',
    ).variables;
    expect(variables.updates.picture).toBe('');
  });
});

// ── newsletterDelete ──────────────────────────────────────────────────

describe('newsletterDelete', () => {
  it('sends correct delete query', async () => {
    const { socket, getLastQuery } = createSocket();
    await socket.newsletterDelete('nl@newsletter');
    const query = getLastQuery();
    const variables = JSON.parse(
      getBinaryNodeChild(query!, 'query')?.content?.toString() ?? '{}',
    ).variables;
    expect(variables.newsletter_id).toBe('nl@newsletter');
  });
});

// ── newsletterFetchMessages ───────────────────────────────────────────

describe('newsletterFetchMessages', () => {
  it('builds correct IQ stanza for fetching messages', async () => {
    const { socket, getLastQuery } = createSocket();
    await socket.newsletterFetchMessages('nl@newsletter', 50);
    const query = getLastQuery();
    expect(query?.tag).toBe('iq');
    expect(query?.attrs.xmlns).toBe('newsletter');
    expect(query?.attrs.to).toBe('nl@newsletter');
    expect(query?.attrs.type).toBe('get');
    const msgUpdates = getBinaryNodeChild(query!, 'message_updates');
    expect(msgUpdates?.attrs.count).toBe('50');
  });

  it('includes since and after when provided', async () => {
    const { socket, getLastQuery } = createSocket();
    await socket.newsletterFetchMessages('nl@newsletter', 20, 1700000000, 'msg-123');
    const query = getLastQuery();
    const msgUpdates = getBinaryNodeChild(query!, 'message_updates');
    expect(msgUpdates?.attrs.count).toBe('20');
    expect(msgUpdates?.attrs.since).toBe('1700000000');
    expect(msgUpdates?.attrs.after).toBe('msg-123');
  });
});

// ── subscribeNewsletterUpdates ────────────────────────────────────────

describe('subscribeNewsletterUpdates', () => {
  it('sends correct IQ stanza with live_updates tag', async () => {
    const response: BinaryNode = {
      tag: 'iq',
      attrs: { type: 'result', id: 'resp' },
      content: [{ tag: 'live_updates', attrs: { duration: '3600' }, content: [] }],
    };
    const { socket, getLastQuery } = createSocket(response);
    const result = await socket.subscribeNewsletterUpdates('nl@newsletter');

    const query = getLastQuery();
    expect(query?.tag).toBe('iq');
    expect(query?.attrs.type).toBe('set');
    expect(query?.attrs.xmlns).toBe('newsletter');
    expect(query?.attrs.to).toBe('nl@newsletter');
    expect(result).toEqual({ duration: '3600' });
  });

  it('returns null when no duration attr', async () => {
    const response: BinaryNode = {
      tag: 'iq',
      attrs: { type: 'result', id: 'resp' },
      content: [{ tag: 'live_updates', attrs: {}, content: [] }],
    };
    const { socket } = createSocket(response);
    const result = await socket.subscribeNewsletterUpdates('nl@newsletter');
    expect(result).toBeNull();
  });
});

// ── GraphQL error handling ────────────────────────────────────────────

describe('Mex error handling', () => {
  it('throws on GraphQL errors', async () => {
    const errorContent = JSON.stringify({
      errors: [{ message: 'Not authorized', extensions: { error_code: 403 } }],
    });
    // Override with error content but default response handler will process it
    const { socket } = createSocket(undefined, errorContent);
    await expect(socket.newsletterFollow('nl@newsletter')).rejects.toThrow('Newsletter API error');
  });
});
