/** Key pair for cryptographic operations */
export interface KeyPair {
  public: Uint8Array;
  private: Uint8Array;
}

/** Signed key pair with signature and key ID */
export interface SignedKeyPair extends KeyPair {
  signature: Uint8Array;
  keyId: number;
}

/** Signal protocol credentials */
export interface SignalCreds {
  readonly signedIdentityKey: KeyPair;
  readonly signedPreKey: SignedKeyPair;
  readonly registrationId: number;
}

/** Contact info for the authenticated user */
export interface Contact {
  id: string;
  name?: string;
  notify?: string;
  verifiedName?: string;
  imgUrl?: string | null;
  status?: string;
}

/** Account settings */
export interface AccountSettings {
  unarchiveChats: boolean;
  defaultDisappearingMode?: {
    ephemeralExpiration: number;
    ephemeralSettingTimestamp: number;
  };
}

/** Minimal message reference */
export interface MinimalMessage {
  key: {
    remoteJid?: string;
    fromMe?: boolean;
    id?: string;
  };
  messageTimestamp: number;
}

/** Full authentication credentials */
export interface AuthenticationCreds extends SignalCreds {
  readonly noiseKey: KeyPair;
  readonly pairingEphemeralKeyPair: KeyPair;
  advSecretKey: string;
  me?: Contact;
  account?: Record<string, unknown>;
  signalIdentities?: Array<{
    identifier: { name: string; deviceId: number };
    identifierKey: Uint8Array;
  }>;
  myAppStateKeyId?: string;
  firstUnuploadedPreKeyId: number;
  nextPreKeyId: number;
  lastAccountSyncTimestamp?: number;
  platform?: string;
  processedHistoryMessages: MinimalMessage[];
  accountSyncCounter: number;
  accountSettings: AccountSettings;
  registered: boolean;
  pairingCode: string | undefined;
  lastPropHash: string | undefined;
  routingInfo: Buffer | undefined;
}

/** Signal data type mapping for key storage */
export interface SignalDataTypeMap {
  'pre-key': KeyPair;
  session: Uint8Array;
  'sender-key': Uint8Array;
  'sender-key-memory': Record<string, boolean>;
  'app-state-sync-key': Record<string, unknown>;
  'app-state-sync-version': Record<string, unknown>;
  'lid-mapping': string;
  'device-list': string[];
  tctoken: { token: Buffer; timestamp?: string };
}

/** Partial signal data for batch set operations */
export type SignalDataSet = {
  [T in keyof SignalDataTypeMap]?: Record<string, SignalDataTypeMap[T] | null>;
};

/** Signal key store interface — the vault for encryption keys */
export interface SignalKeyStore {
  get<T extends keyof SignalDataTypeMap>(
    type: T,
    ids: string[],
  ): Promise<Record<string, SignalDataTypeMap[T]>>;
  set(data: SignalDataSet): Promise<void>;
  clear?(): Promise<void>;
}

/** Complete authentication state */
export interface AuthenticationState {
  creds: AuthenticationCreds;
  keys: SignalKeyStore;
}
