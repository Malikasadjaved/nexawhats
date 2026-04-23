/**
 * CiphertextMessage — abstract base with Signal protocol constants.
 *
 * Ported verbatim from Baileys `Signal/Group/ciphertext-message.js`.
 *
 * All values are part of the Signal protocol and MUST NOT change.
 */
export class CiphertextMessage {
  readonly UNSUPPORTED_VERSION = 1;
  readonly CURRENT_VERSION = 3;
  readonly WHISPER_TYPE = 2;
  readonly PREKEY_TYPE = 3;
  readonly SENDERKEY_TYPE = 4;
  readonly SENDERKEY_DISTRIBUTION_TYPE = 5;
  readonly ENCRYPTED_MESSAGE_OVERHEAD = 53;
}
