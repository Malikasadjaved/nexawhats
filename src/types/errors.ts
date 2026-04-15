/** Disconnect reason codes from WhatsApp */
export enum DisconnectReason {
  loggedOut = 401,
  forbidden = 403,
  rateLimited = 405,
  timeout = 408,
  preconditionFailed = 428,
  replaced = 440,
  tooManyRequests = 463,
  restartRequired = 515,
}

/** Error codes specific to NexaWhats */
export enum NexaWhatsErrorCode {
  CONNECTION_FAILED = 'CONNECTION_FAILED',
  CONNECTION_TIMEOUT = 'CONNECTION_TIMEOUT',
  RATE_LIMITED = 'RATE_LIMITED',
  BANNED = 'BANNED',
  LOGGED_OUT = 'LOGGED_OUT',
  SESSION_CORRUPTED = 'SESSION_CORRUPTED',
  AUTH_FAILED = 'AUTH_FAILED',
  SEND_FAILED = 'SEND_FAILED',
  MEDIA_UPLOAD_FAILED = 'MEDIA_UPLOAD_FAILED',
  MEDIA_DOWNLOAD_FAILED = 'MEDIA_DOWNLOAD_FAILED',
  CIRCUIT_BREAKER_OPEN = 'CIRCUIT_BREAKER_OPEN',
  QUEUE_FULL = 'QUEUE_FULL',
  MAX_RETRIES_EXCEEDED = 'MAX_RETRIES_EXCEEDED',
  PROTOCOL_ERROR = 'PROTOCOL_ERROR',
  ENCRYPTION_ERROR = 'ENCRYPTION_ERROR',
}
