import { NexaWhatsErrorCode } from '../types/errors.js';
import { NexaWhatsError } from './connection.js';

/** Authentication failed */
export class AuthError extends NexaWhatsError {
  constructor(message: string) {
    super(message, NexaWhatsErrorCode.AUTH_FAILED, false);
    this.name = 'AuthError';
  }
}

/** Session data is corrupted and cannot be loaded */
export class SessionCorruptedError extends NexaWhatsError {
  constructor(message = 'Session data is corrupted — delete and re-authenticate') {
    super(message, NexaWhatsErrorCode.SESSION_CORRUPTED, false);
    this.name = 'SessionCorruptedError';
  }
}
