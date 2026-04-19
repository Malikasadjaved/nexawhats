import { describe, expect, it } from 'vitest';
import {
  areJidsSameUser,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidUser,
  isLidUser,
  isPnUser,
  isJidMetaAI,
  isJidBot,
  isJidStatusBroadcast,
  isHostedPnUser,
  isHostedLidUser,
  jidDecode,
  jidEncode,
  jidNormalizedUser,
  phoneFromJid,
  transferDevice,
  getServerFromDomainType,
} from '../../../src/utils/jid.js';
import { WAJIDDomains } from '../../../src/types/jid.js';

describe('jidEncode', () => {
  it('should encode a basic user JID', () => {
    expect(jidEncode('923124166950', 's.whatsapp.net')).toBe('923124166950@s.whatsapp.net');
  });

  it('should encode a JID with device', () => {
    expect(jidEncode('923124166950', 's.whatsapp.net', 1)).toBe('923124166950:1@s.whatsapp.net');
  });

  it('should encode a group JID', () => {
    expect(jidEncode('120363123456789', 'g.us')).toBe('120363123456789@g.us');
  });

  it('should encode a LID JID', () => {
    expect(jidEncode('197151900590225', 'lid')).toBe('197151900590225@lid');
  });

  it('should handle null user', () => {
    expect(jidEncode(null, 's.whatsapp.net')).toBe('@s.whatsapp.net');
  });

  it('should handle undefined user', () => {
    expect(jidEncode(undefined, 's.whatsapp.net')).toBe('@s.whatsapp.net');
  });

  it('should not add device suffix for device 0', () => {
    expect(jidEncode('923124166950', 's.whatsapp.net', 0)).toBe('923124166950@s.whatsapp.net');
  });

  it('should encode a JID with agent', () => {
    expect(jidEncode('923124166950', 's.whatsapp.net', undefined, 2)).toBe(
      '923124166950_2@s.whatsapp.net',
    );
  });
});

describe('jidDecode', () => {
  it('should decode a user JID with domainType', () => {
    const result = jidDecode('923124166950@s.whatsapp.net');
    expect(result).toEqual({
      user: '923124166950',
      server: 's.whatsapp.net',
      domainType: WAJIDDomains.WHATSAPP,
      device: undefined,
    });
  });

  it('should decode a JID with device', () => {
    const result = jidDecode('923124166950:1@s.whatsapp.net');
    expect(result).toEqual({
      user: '923124166950',
      device: 1,
      server: 's.whatsapp.net',
      domainType: WAJIDDomains.WHATSAPP,
    });
  });

  it('should decode a group JID', () => {
    const result = jidDecode('120363123456789@g.us');
    expect(result?.user).toBe('120363123456789');
    expect(result?.server).toBe('g.us');
  });

  it('should decode a LID JID', () => {
    const result = jidDecode('197151900590225@lid');
    expect(result?.user).toBe('197151900590225');
    expect(result?.server).toBe('lid');
    expect(result?.domainType).toBe(WAJIDDomains.LID);
  });

  it('should decode a hosted JID', () => {
    const result = jidDecode('123@hosted');
    expect(result?.domainType).toBe(WAJIDDomains.HOSTED);
  });

  it('should decode a hosted.lid JID', () => {
    const result = jidDecode('123@hosted.lid');
    expect(result?.domainType).toBe(WAJIDDomains.HOSTED_LID);
  });

  it('should return undefined for invalid JID (no @)', () => {
    expect(jidDecode('invalid')).toBeUndefined();
  });

  it('should return undefined for null', () => {
    expect(jidDecode(null)).toBeUndefined();
  });

  it('should return undefined for undefined', () => {
    expect(jidDecode(undefined)).toBeUndefined();
  });

  it('should decode broadcast JID', () => {
    const result = jidDecode('status@broadcast');
    expect(result?.user).toBe('status');
    expect(result?.server).toBe('broadcast');
  });
});

describe('jidNormalizedUser', () => {
  it('should normalize c.us to s.whatsapp.net', () => {
    expect(jidNormalizedUser('923124166950@c.us')).toBe('923124166950@s.whatsapp.net');
  });

  it('should keep s.whatsapp.net as is', () => {
    expect(jidNormalizedUser('923124166950@s.whatsapp.net')).toBe('923124166950@s.whatsapp.net');
  });

  it('should strip device from JID', () => {
    expect(jidNormalizedUser('923124166950:1@s.whatsapp.net')).toBe(
      '923124166950@s.whatsapp.net',
    );
  });

  it('should keep group JIDs as is', () => {
    expect(jidNormalizedUser('120363123456789@g.us')).toBe('120363123456789@g.us');
  });

  it('should return empty string for invalid JID', () => {
    expect(jidNormalizedUser('invalid')).toBe('');
  });
});

describe('JID type checks', () => {
  it('isJidGroup', () => {
    expect(isJidGroup('120363123456789@g.us')).toBe(true);
    expect(isJidGroup('923124166950@s.whatsapp.net')).toBe(false);
    expect(isJidGroup(null)).toBe(false);
  });

  it('isJidBroadcast', () => {
    expect(isJidBroadcast('status@broadcast')).toBe(true);
    expect(isJidBroadcast('923124166950@s.whatsapp.net')).toBe(false);
  });

  it('isJidNewsletter', () => {
    expect(isJidNewsletter('123@newsletter')).toBe(true);
    expect(isJidNewsletter('923124166950@s.whatsapp.net')).toBe(false);
  });

  it('isLidUser', () => {
    expect(isLidUser('197151900590225@lid')).toBe(true);
    expect(isLidUser('923124166950@s.whatsapp.net')).toBe(false);
    expect(isLidUser(null)).toBe(false);
  });

  it('isPnUser', () => {
    expect(isPnUser('923124166950@s.whatsapp.net')).toBe(true);
    expect(isPnUser('120363123456789@g.us')).toBe(false);
    expect(isPnUser(null)).toBe(false);
  });

  it('isJidUser', () => {
    expect(isJidUser('923124166950@s.whatsapp.net')).toBe(true);
    expect(isJidUser('923124166950@c.us')).toBe(true);
    expect(isJidUser('120363123456789@g.us')).toBe(false);
  });

  it('isJidMetaAI', () => {
    expect(isJidMetaAI('something@bot')).toBe(true);
    expect(isJidMetaAI('923124166950@s.whatsapp.net')).toBe(false);
    expect(isJidMetaAI(null)).toBe(false);
  });

  it('isJidBot', () => {
    expect(isJidBot('13135550001@c.us')).toBe(true);
    expect(isJidBot('13165550001@c.us')).toBe(true);
    expect(isJidBot('923124166950@c.us')).toBe(false);
    expect(isJidBot(null)).toBe(false);
  });

  it('isJidStatusBroadcast', () => {
    expect(isJidStatusBroadcast('status@broadcast')).toBe(true);
    expect(isJidStatusBroadcast('other@broadcast')).toBe(false);
    expect(isJidStatusBroadcast(null)).toBe(false);
  });

  it('isHostedPnUser', () => {
    expect(isHostedPnUser('123@hosted')).toBe(true);
    expect(isHostedPnUser('123@s.whatsapp.net')).toBe(false);
  });

  it('isHostedLidUser', () => {
    expect(isHostedLidUser('123@hosted.lid')).toBe(true);
    expect(isHostedLidUser('123@lid')).toBe(false);
  });
});

describe('phoneFromJid', () => {
  it('should extract phone from s.whatsapp.net JID', () => {
    expect(phoneFromJid('923124166950@s.whatsapp.net')).toBe('923124166950');
  });

  it('should extract phone from c.us JID', () => {
    expect(phoneFromJid('923124166950@c.us')).toBe('923124166950');
  });

  it('should return undefined for group JID', () => {
    expect(phoneFromJid('120363123456789@g.us')).toBeUndefined();
  });

  it('should return undefined for LID JID', () => {
    expect(phoneFromJid('197151900590225@lid')).toBeUndefined();
  });
});

describe('areJidsSameUser', () => {
  it('should match same user on different servers', () => {
    expect(
      areJidsSameUser('923124166950@s.whatsapp.net', '923124166950@c.us'),
    ).toBe(true);
  });

  it('should match same user with different devices', () => {
    expect(
      areJidsSameUser(
        '923124166950@s.whatsapp.net',
        '923124166950:1@s.whatsapp.net',
      ),
    ).toBe(true);
  });

  it('should not match different users', () => {
    expect(
      areJidsSameUser(
        '923124166950@s.whatsapp.net',
        '923315244441@s.whatsapp.net',
      ),
    ).toBe(false);
  });

  it('should handle null inputs', () => {
    expect(areJidsSameUser(null, '923124166950@s.whatsapp.net')).toBe(false);
  });
});

describe('transferDevice', () => {
  it('should transfer device from one JID to another', () => {
    const result = transferDevice(
      '923124166950:3@s.whatsapp.net',
      '923315244441@s.whatsapp.net',
    );
    expect(result).toBe('923315244441:3@s.whatsapp.net');
  });

  it('should default device to 0 when source has none', () => {
    const result = transferDevice(
      '923124166950@s.whatsapp.net',
      '923315244441@s.whatsapp.net',
    );
    // device 0 is falsy so jidEncode won't add :0
    expect(result).toBe('923315244441@s.whatsapp.net');
  });
});

describe('getServerFromDomainType', () => {
  it('should return lid for LID domain', () => {
    expect(getServerFromDomainType('s.whatsapp.net', WAJIDDomains.LID)).toBe('lid');
  });

  it('should return hosted for HOSTED domain', () => {
    expect(getServerFromDomainType('s.whatsapp.net', WAJIDDomains.HOSTED)).toBe('hosted');
  });

  it('should return hosted.lid for HOSTED_LID domain', () => {
    expect(getServerFromDomainType('s.whatsapp.net', WAJIDDomains.HOSTED_LID)).toBe('hosted.lid');
  });

  it('should return initial server for WHATSAPP domain', () => {
    expect(getServerFromDomainType('g.us', WAJIDDomains.WHATSAPP)).toBe('g.us');
  });

  it('should return initial server for undefined domain', () => {
    expect(getServerFromDomainType('s.whatsapp.net', undefined)).toBe('s.whatsapp.net');
  });
});

describe('WAJIDDomains', () => {
  it('has correct numeric values', () => {
    expect(WAJIDDomains.WHATSAPP).toBe(0);
    expect(WAJIDDomains.LID).toBe(1);
    expect(WAJIDDomains.HOSTED).toBe(128);
    expect(WAJIDDomains.HOSTED_LID).toBe(129);
  });
});
