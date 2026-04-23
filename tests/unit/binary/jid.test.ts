import { describe, expect, it } from 'vitest';
import {
  WAJIDDomains,
  areJidsSameUser,
  isHostedLidUser,
  isHostedPnUser,
  isJidBot,
  isJidBroadcast,
  isJidGroup,
  isJidMetaAI,
  isJidNewsletter,
  isJidStatusBroadcast,
  isLidUser,
  isPnUser,
  jidDecode,
  jidEncode,
  jidNormalizedUser,
  transferDevice,
} from '../../../src/binary/index.js';

describe('jid / jidDecode', () => {
  it('decodes a plain phone-number JID', () => {
    const r = jidDecode('923315244441@s.whatsapp.net');
    expect(r).toEqual({
      server: 's.whatsapp.net',
      user: '923315244441',
      device: undefined,
      domainType: WAJIDDomains.WHATSAPP,
    });
  });

  it('decodes a JID with device id', () => {
    const r = jidDecode('923394572313:22@s.whatsapp.net');
    expect(r?.user).toBe('923394572313');
    expect(r?.device).toBe(22);
    expect(r?.server).toBe('s.whatsapp.net');
    expect(r?.domainType).toBe(WAJIDDomains.WHATSAPP);
  });

  it('decodes an @lid JID as LID domain', () => {
    const r = jidDecode('197151900590225@lid');
    expect(r?.user).toBe('197151900590225');
    expect(r?.server).toBe('lid');
    expect(r?.domainType).toBe(WAJIDDomains.LID);
  });

  it('decodes @hosted and @hosted.lid correctly', () => {
    expect(jidDecode('123@hosted')?.domainType).toBe(WAJIDDomains.HOSTED);
    expect(jidDecode('123@hosted.lid')?.domainType).toBe(WAJIDDomains.HOSTED_LID);
  });

  it('parses agent from user_agent prefix', () => {
    // "_1" → agent field reported as numeric parse of "1"
    const r = jidDecode('12345_1:3@something');
    expect(r?.user).toBe('12345');
    expect(r?.device).toBe(3);
    // agent is reflected in domainType when not a known server
    expect(r?.domainType).toBe(1);
  });

  it('returns undefined for JIDs without @', () => {
    expect(jidDecode('notajid')).toBeUndefined();
    expect(jidDecode('')).toBeUndefined();
    expect(jidDecode(null)).toBeUndefined();
    expect(jidDecode(undefined)).toBeUndefined();
  });
});

describe('jid / jidEncode', () => {
  it('produces plain user@server', () => {
    expect(jidEncode('123', 's.whatsapp.net')).toBe('123@s.whatsapp.net');
  });
  it('appends device when set', () => {
    expect(jidEncode('123', 's.whatsapp.net', 7)).toBe('123:7@s.whatsapp.net');
  });
  it('appends agent when set', () => {
    expect(jidEncode('123', 's.whatsapp.net', undefined, 2)).toBe('123_2@s.whatsapp.net');
  });
  it('appends agent AND device when both set', () => {
    expect(jidEncode('123', 's.whatsapp.net', 7, 2)).toBe('123_2:7@s.whatsapp.net');
  });
  it('tolerates null/empty user', () => {
    expect(jidEncode(null, 's.whatsapp.net')).toBe('@s.whatsapp.net');
    expect(jidEncode(undefined, 's.whatsapp.net')).toBe('@s.whatsapp.net');
  });
  it('device=0 is omitted', () => {
    expect(jidEncode('123', 's.whatsapp.net', 0)).toBe('123@s.whatsapp.net');
  });
});

describe('jid / domain predicates', () => {
  it('isPnUser only matches @s.whatsapp.net', () => {
    expect(isPnUser('123@s.whatsapp.net')).toBe(true);
    expect(isPnUser('123@lid')).toBe(false);
    expect(isPnUser(undefined)).toBe(false);
  });
  it('isLidUser only matches @lid', () => {
    expect(isLidUser('197151900590225@lid')).toBe(true);
    expect(isLidUser('197151900590225@s.whatsapp.net')).toBe(false);
  });
  it('isHostedPnUser / isHostedLidUser', () => {
    expect(isHostedPnUser('x@hosted')).toBe(true);
    expect(isHostedLidUser('x@hosted.lid')).toBe(true);
    // @hosted.lid ends with `.lid`, NOT with `@hosted`, so isHostedPnUser
    // returns false for it — mirrors Baileys' behaviour.
    expect(isHostedPnUser('x@hosted.lid')).toBe(false);
    expect(isHostedLidUser('x@hosted')).toBe(false);
  });
  it('isJidGroup / isJidBroadcast / isJidNewsletter', () => {
    expect(isJidGroup('123@g.us')).toBe(true);
    expect(isJidBroadcast('abc@broadcast')).toBe(true);
    expect(isJidStatusBroadcast('status@broadcast')).toBe(true);
    expect(isJidStatusBroadcast('abc@broadcast')).toBe(false);
    expect(isJidNewsletter('abc@newsletter')).toBe(true);
  });
  it('isJidMetaAI matches @bot suffix', () => {
    expect(isJidMetaAI('meta-ai@bot')).toBe(true);
    expect(isJidMetaAI('meta-ai@s.whatsapp.net')).toBe(false);
  });
  it('isJidBot matches the known bot-number regex', () => {
    expect(isJidBot('13135551234@c.us')).toBe(true);
    expect(isJidBot('13165550012@c.us')).toBe(true);
    expect(isJidBot('13135551234@s.whatsapp.net')).toBe(false);
    expect(isJidBot('12345@c.us')).toBe(false);
  });
});

describe('jid / areJidsSameUser', () => {
  it('matches same user across different devices', () => {
    expect(areJidsSameUser('923394572313@s.whatsapp.net', '923394572313:22@s.whatsapp.net')).toBe(
      true,
    );
  });
  it('rejects different users', () => {
    expect(areJidsSameUser('923394572313@s.whatsapp.net', '923315244441@s.whatsapp.net')).toBe(
      false,
    );
  });
});

describe('jid / jidNormalizedUser', () => {
  it('rewrites @c.us → @s.whatsapp.net', () => {
    expect(jidNormalizedUser('123@c.us')).toBe('123@s.whatsapp.net');
  });
  it('preserves other servers', () => {
    expect(jidNormalizedUser('123@lid')).toBe('123@lid');
  });
  it('drops device when normalizing (matches Baileys)', () => {
    // jidNormalizedUser re-encodes without passing the device argument, so
    // the device is dropped.
    expect(jidNormalizedUser('123:5@s.whatsapp.net')).toBe('123@s.whatsapp.net');
  });
  it('returns empty string for unparseable JID', () => {
    expect(jidNormalizedUser('not-a-jid')).toBe('');
  });
});

describe('jid / transferDevice', () => {
  it('copies device from fromJid onto toJid', () => {
    expect(transferDevice('123:7@s.whatsapp.net', '456@lid')).toBe('456:7@lid');
  });
  it('device=0 is dropped on encode (no `:0` suffix)', () => {
    expect(transferDevice('123@s.whatsapp.net', '456@lid')).toBe('456@lid');
  });
});
