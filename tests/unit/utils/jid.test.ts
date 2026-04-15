import { describe, expect, it } from 'vitest';
import {
  areJidsSameUser,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidUser,
  isLidUser,
  jidDecode,
  jidEncode,
  jidNormalizedUser,
  phoneFromJid,
} from '../../../src/utils/jid.js';

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
});

describe('jidDecode', () => {
  it('should decode a user JID', () => {
    expect(jidDecode('923124166950@s.whatsapp.net')).toEqual({
      user: '923124166950',
      server: 's.whatsapp.net',
    });
  });

  it('should decode a JID with device', () => {
    expect(jidDecode('923124166950:1@s.whatsapp.net')).toEqual({
      user: '923124166950',
      device: 1,
      server: 's.whatsapp.net',
    });
  });

  it('should decode a group JID', () => {
    expect(jidDecode('120363123456789@g.us')).toEqual({
      user: '120363123456789',
      server: 'g.us',
    });
  });

  it('should decode a LID JID', () => {
    expect(jidDecode('197151900590225@lid')).toEqual({
      user: '197151900590225',
      server: 'lid',
    });
  });

  it('should return undefined for invalid JID (no @)', () => {
    expect(jidDecode('invalid')).toBeUndefined();
  });

  it('should decode broadcast JID', () => {
    expect(jidDecode('status@broadcast')).toEqual({
      user: 'status',
      server: 'broadcast',
    });
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
    expect(jidNormalizedUser('923124166950:1@s.whatsapp.net')).toBe('923124166950@s.whatsapp.net');
  });

  it('should keep group JIDs as is', () => {
    expect(jidNormalizedUser('120363123456789@g.us')).toBe('120363123456789@g.us');
  });
});

describe('JID type checks', () => {
  it('isJidGroup', () => {
    expect(isJidGroup('120363123456789@g.us')).toBe(true);
    expect(isJidGroup('923124166950@s.whatsapp.net')).toBe(false);
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
  });

  it('isJidUser', () => {
    expect(isJidUser('923124166950@s.whatsapp.net')).toBe(true);
    expect(isJidUser('923124166950@c.us')).toBe(true);
    expect(isJidUser('120363123456789@g.us')).toBe(false);
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
    expect(areJidsSameUser('923124166950@s.whatsapp.net', '923124166950@c.us')).toBe(true);
  });

  it('should match same user with different devices', () => {
    expect(areJidsSameUser('923124166950@s.whatsapp.net', '923124166950:1@s.whatsapp.net')).toBe(
      true,
    );
  });

  it('should not match different users', () => {
    expect(areJidsSameUser('923124166950@s.whatsapp.net', '923315244441@s.whatsapp.net')).toBe(
      false,
    );
  });
});
