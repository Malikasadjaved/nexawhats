/**
 * SenderKeyName — identifies a (group, sender) pair.
 *
 * Ported verbatim from Baileys `Signal/Group/sender-key-name.js`.
 *
 * Used as the lookup key into the sender-key store. The `sender`
 * parameter is a `ProtocolAddress`-like object exposing `{ id,
 * deviceId, toString() }`.
 */

export interface SenderAddress {
  readonly id: string;
  readonly deviceId: number;
  toString(): string;
}

function isNull(str: string | null | undefined): boolean {
  return str === null || str === '';
}

function intValue(num: number): number {
  const MAX_VALUE = 0x7fffffff;
  const MIN_VALUE = -0x80000000;
  if (num > MAX_VALUE || num < MIN_VALUE) {
    return num & 0xffffffff;
  }
  return num;
}

function hashCode(strKey: string): number {
  let hash = 0;
  if (!isNull(strKey)) {
    for (let i = 0; i < strKey.length; i++) {
      hash = hash * 31 + strKey.charCodeAt(i);
      hash = intValue(hash);
    }
  }
  return hash;
}

export class SenderKeyName {
  readonly groupId: string;
  readonly sender: SenderAddress;

  constructor(groupId: string, sender: SenderAddress) {
    this.groupId = groupId;
    this.sender = sender;
  }

  getGroupId(): string {
    return this.groupId;
  }

  getSender(): SenderAddress {
    return this.sender;
  }

  serialize(): string {
    return `${this.groupId}::${this.sender.id}::${this.sender.deviceId}`;
  }

  toString(): string {
    return this.serialize();
  }

  equals(other: SenderKeyName | null): boolean {
    if (other === null) return false;
    return this.groupId === other.groupId && this.sender.toString() === other.sender.toString();
  }

  hashCode(): number {
    return hashCode(this.groupId) ^ hashCode(this.sender.toString());
  }
}
