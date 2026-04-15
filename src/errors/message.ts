import { NexaWhatsErrorCode } from '../types/errors.js';
import { NexaWhatsError } from './connection.js';

/** Message send failed */
export class SendError extends NexaWhatsError {
  readonly jid: string;
  readonly attempts: number;

  constructor(jid: string, message: string, attempts = 1) {
    super(message, NexaWhatsErrorCode.SEND_FAILED, attempts < 3);
    this.name = 'SendError';
    this.jid = jid;
    this.attempts = attempts;
  }
}

/** Media upload failed */
export class MediaUploadError extends NexaWhatsError {
  readonly mediaType: string;

  constructor(mediaType: string, message: string) {
    super(message, NexaWhatsErrorCode.MEDIA_UPLOAD_FAILED, true);
    this.name = 'MediaUploadError';
    this.mediaType = mediaType;
  }
}

/** Media download failed */
export class MediaDownloadError extends NexaWhatsError {
  readonly mediaType: string;

  constructor(mediaType: string, message: string) {
    super(message, NexaWhatsErrorCode.MEDIA_DOWNLOAD_FAILED, true);
    this.name = 'MediaDownloadError';
    this.mediaType = mediaType;
  }
}

/** Message queue is full */
export class QueueFullError extends NexaWhatsError {
  readonly queueSize: number;

  constructor(queueSize: number) {
    super(
      `Message queue is full (${queueSize} pending) — try again later`,
      NexaWhatsErrorCode.QUEUE_FULL,
      true,
    );
    this.name = 'QueueFullError';
    this.queueSize = queueSize;
  }
}
