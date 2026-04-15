export {
  NexaWhatsError,
  ConnectionError,
  RateLimitError,
  BannedError,
  LoggedOutError,
  ConnectionTimeoutError,
  CircuitBreakerOpenError,
} from './connection.js';
export { AuthError, SessionCorruptedError } from './auth.js';
export { SendError, MediaUploadError, MediaDownloadError, QueueFullError } from './message.js';
