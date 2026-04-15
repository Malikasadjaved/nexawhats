import type { WAMediaUpload } from '../types/message.js';

/**
 * Media handling utilities.
 *
 * Upload/download with retry, progress callbacks, and encryption
 * will be fully implemented in Phase 6 when we fork Baileys' media utils.
 */

/** Progress callback for media operations */
export type ProgressCallback = (progress: {
  bytesTransferred: number;
  totalBytes: number;
  percentage: number;
}) => void;

/** Options for media download */
export interface MediaDownloadOptions {
  /** Timeout in ms (default: 60000) */
  timeoutMs?: number;
  /** Maximum retry attempts (default: 3) */
  maxRetries?: number;
  /** Progress callback */
  onProgress?: ProgressCallback;
}

/** Options for media upload */
export interface MediaUploadOptions {
  /** Timeout in ms (default: 60000) */
  timeoutMs?: number;
  /** Maximum retry attempts (default: 3) */
  maxRetries?: number;
  /** Progress callback */
  onProgress?: ProgressCallback;
}

/** Resolve a WAMediaUpload to a Buffer */
export async function resolveMediaUpload(media: WAMediaUpload): Promise<Buffer> {
  if (Buffer.isBuffer(media)) {
    return media;
  }

  if ('stream' in media) {
    const chunks: Buffer[] = [];
    for await (const chunk of media.stream as AsyncIterable<Buffer>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  if ('url' in media) {
    const url = typeof media.url === 'string' ? media.url : media.url.toString();
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch media from URL: ${response.status} ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  throw new Error('Invalid media upload source');
}
