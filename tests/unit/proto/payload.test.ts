/**
 * D5 — ClientPayload builders round-trip against the live WAProto.
 * Skipped cleanly when Baileys is not installed.
 */
import { describe, expect, it } from 'vitest';
import { isProtoAvailable, proto } from '../../../src/proto/index.js';
import {
  DEFAULT_BROWSER,
  DEFAULT_VERSION,
  encodeBigEndian,
  generateLoginNode,
  generateRegistrationNode,
} from '../../../src/proto/payload.js';
import { initAuthCreds } from '../../../src/utils/auth.js';

const haveProto = isProtoAvailable();

describe('encodeBigEndian', () => {
  it('packs to exactly `length` bytes in big-endian order', () => {
    expect(encodeBigEndian(0x01020304, 4).toString('hex')).toBe('01020304');
    expect(encodeBigEndian(0x0f, 3).toString('hex')).toBe('00000f');
    expect(encodeBigEndian(0xffff, 2).toString('hex')).toBe('ffff');
  });
});

(haveProto ? describe : describe.skip)('generateLoginNode', () => {
  const config = {
    version: DEFAULT_VERSION,
    browser: DEFAULT_BROWSER,
    countryCode: 'US',
  };

  it('encodes to a ClientPayload with passive=true, pull=true, username+device from JID', () => {
    const payload = generateLoginNode('923315244441:3@s.whatsapp.net', config);
    const encoded = proto.ClientPayload.encode(payload).finish() as Uint8Array;
    const decoded = proto.ClientPayload.decode(encoded) as {
      passive: boolean;
      pull: boolean;
      username: { toNumber?(): number } | number;
      device: number;
    };
    expect(decoded.passive).toBe(true);
    expect(decoded.pull).toBe(true);
    const username =
      typeof decoded.username === 'object' && decoded.username?.toNumber
        ? decoded.username.toNumber()
        : (decoded.username as number);
    expect(Number(username)).toBe(923315244441);
    expect(decoded.device).toBe(3);
  });

  it('throws when the JID cannot be decoded', () => {
    expect(() => generateLoginNode('not-a-jid', config)).toThrow(/could not decode/i);
  });
});

(haveProto ? describe : describe.skip)('generateRegistrationNode', () => {
  it('encodes devicePairingData with all required fields', () => {
    const creds = initAuthCreds();
    const payload = generateRegistrationNode(creds, {
      version: DEFAULT_VERSION,
      browser: DEFAULT_BROWSER,
      countryCode: 'US',
    });
    const encoded = proto.ClientPayload.encode(payload).finish() as Uint8Array;
    const decoded = proto.ClientPayload.decode(encoded) as {
      passive: boolean;
      pull: boolean;
      devicePairingData: {
        buildHash: Uint8Array;
        deviceProps: Uint8Array;
        eRegid: Uint8Array;
        eKeytype: Uint8Array;
        eIdent: Uint8Array;
        eSkeyId: Uint8Array;
        eSkeyVal: Uint8Array;
        eSkeySig: Uint8Array;
      };
    };
    expect(decoded.passive).toBe(false);
    expect(decoded.pull).toBe(false);
    const d = decoded.devicePairingData;
    expect(d.buildHash.length).toBe(16); // MD5
    expect(d.eRegid.length).toBe(4);
    expect(d.eKeytype.length).toBe(1);
    expect(d.eKeytype[0]).toBe(0x05);
    expect(d.eIdent.length).toBe(32);
    expect(d.eSkeyId.length).toBe(3);
    expect(d.eSkeyVal.length).toBe(32);
    expect(d.eSkeySig.length).toBe(64);
    expect(d.deviceProps.length).toBeGreaterThan(0);
  });
});
