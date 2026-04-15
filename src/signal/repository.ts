/**
 * Signal Protocol repository interface.
 *
 * Handles encryption/decryption of messages using the Signal Protocol.
 * This will be populated with the actual implementation forked from Baileys
 * in Phase 1.
 */
export interface SignalRepository {
  /** Decrypt a group message */
  decryptGroupMessage(opts: {
    group: string;
    authorJid: string;
    msg: Uint8Array;
  }): Promise<Uint8Array>;

  /** Process sender key distribution message */
  processSenderKeyDistributionMessage(opts: {
    item: Record<string, unknown>;
    authorJid: string;
  }): Promise<void>;

  /** Decrypt a 1:1 message */
  decryptMessage(opts: {
    jid: string;
    type: 'pkmsg' | 'msg';
    ciphertext: Uint8Array;
  }): Promise<Uint8Array>;

  /** Encrypt a 1:1 message */
  encryptMessage(opts: {
    jid: string;
    data: Uint8Array;
  }): Promise<{ type: 'pkmsg' | 'msg'; ciphertext: Uint8Array }>;

  /** Encrypt a group message */
  encryptGroupMessage(opts: {
    group: string;
    data: Uint8Array;
    meId: string;
  }): Promise<{ senderKeyDistributionMessage: Uint8Array; ciphertext: Uint8Array }>;

  /** Validate a Signal session exists */
  validateSession(jid: string): Promise<{ exists: boolean; reason?: string }>;

  /** Delete Signal sessions for JIDs */
  deleteSession(jids: string[]): Promise<void>;
}
