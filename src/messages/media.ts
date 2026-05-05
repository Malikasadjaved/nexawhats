/**
 * Media utilities — encryption, upload, download, and thumbnail generation.
 *
 * Ported from Baileys' `Utils/messages-media.js`.
 */
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { WAMediaUpload } from '../types/message.js';

// ── Constants ──────────────────────────────────────────────────────────

const DEF_HOST = 'mmg.whatsapp.net';

const MEDIA_PATH_MAP: Record<string, string> = {
  audio: '/mms/audio',
  document: '/mms/document',
  gif: '/mms/gif',
  image: '/mms/image',
  ppic: '/mms/ppic',
  product: '/mms/product',
  ptt: '/mms/ptt',
  sticker: '/mms/sticker',
  video: '/mms/video',
  'thumbnail-document': '/mms/thumbnail-document',
  'thumbnail-image': '/mms/thumbnail-image',
  'thumbnail-video': '/mms/thumbnail-video',
  'thumbnail-link': '/mms/thumbnail-link',
  'md-msg-hist': '/mms/md-msg-hist',
  'md-app-state': '/mms/md-app-state',
  ptv: '/mms/ptv',
};

const MEDIA_HKDF_KEY_MAPPING: Record<string, string> = {
  audio: 'Audio',
  document: 'Document',
  gif: 'Video',
  image: 'Image',
  ppic: 'Profile Picture',
  product: 'Image',
  ptt: 'Audio',
  sticker: 'Image',
  video: 'Video',
  'thumbnail-document': 'Document Thumbnail',
  'thumbnail-image': 'Image Thumbnail',
  'thumbnail-video': 'Video Thumbnail',
  'thumbnail-link': 'Link Thumbnail',
  'md-msg-hist': 'History',
  'md-app-state': 'App State',
  ptv: 'Video',
};

// ── Types ──────────────────────────────────────────────────────────────

export type ProgressCallback = (progress: {
  bytesTransferred: number;
  totalBytes: number;
  percentage: number;
}) => void;

export interface MediaDownloadOptions {
  timeoutMs?: number;
  maxRetries?: number;
  onProgress?: ProgressCallback;
}

export interface MediaUploadOptions {
  timeoutMs?: number;
  maxRetries?: number;
  onProgress?: ProgressCallback;
}

export interface MediaConnInfo {
  hosts: Array<{ hostname: string; maxContentLengthBytes?: number }>;
  auth: string;
  ttl: number;
  fetchDate: Date;
}

export interface EncryptedStreamResult {
  mediaKey: Buffer;
  encFilePath: string;
  fileEncSha256: Buffer;
  fileSha256: Buffer;
  fileLength: number;
  mac: Buffer;
}

export interface MediaUploadResult {
  mediaUrl?: string;
  directPath?: string;
  fbid?: string;
  ts?: string;
}

// ── Resolve media ──────────────────────────────────────────────────────

/** Resolve a WAMediaUpload to a Buffer. */
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
      throw new Error(`Failed to fetch media: ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  throw new Error('Invalid media upload source');
}

// ── Stream helpers ─────────────────────────────────────────────────────

function toReadable(buffer: Buffer): Readable {
  const readable = new Readable({ read: () => {} });
  readable.push(buffer);
  readable.push(null);
  return readable;
}

async function getStream(item: WAMediaUpload): Promise<{ stream: Readable; type: string }> {
  if (Buffer.isBuffer(item)) {
    return { stream: toReadable(item), type: 'buffer' };
  }
  if ('stream' in item) {
    return { stream: item.stream as Readable, type: 'readable' };
  }
  const urlStr = item.url.toString();
  if (urlStr.startsWith('data:')) {
    const dataPart = urlStr.split(',')[1] ?? '';
    const buffer = Buffer.from(dataPart, 'base64');
    return { stream: toReadable(buffer), type: 'buffer' };
  }
  if (urlStr.startsWith('http://') || urlStr.startsWith('https://')) {
    const response = await fetch(urlStr);
    if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
    const buf = Buffer.from(await response.arrayBuffer());
    return { stream: toReadable(buf), type: 'remote' };
  }
  return { stream: createReadStream(urlStr) as unknown as Readable, type: 'file' };
}

// ── Key derivation ─────────────────────────────────────────────────────

/** Derive the HKDF info string for a media type. */
function hkdfInfoKey(type: string): string {
  const hkdfInfo = MEDIA_HKDF_KEY_MAPPING[type] || 'Image';
  return `WhatsApp ${hkdfInfo} Keys`;
}

/**
 * Derive encryption keys (iv, cipherKey, macKey) from a 32-byte media key.
 */
export async function getMediaKeys(
  buffer: Buffer | string,
  mediaType: string,
): Promise<{ iv: Buffer; cipherKey: Buffer; macKey: Buffer }> {
  if (!buffer) {
    throw new Error('Cannot derive from empty media key');
  }
  let keyBytes: Buffer;
  if (typeof buffer === 'string') {
    keyBytes = Buffer.from(buffer.replace('data:;base64,', ''), 'base64');
  } else {
    keyBytes = buffer;
  }

  const { hkdf } = await import('../utils/crypto.js');
  const expanded = await hkdf(keyBytes, 112, { info: hkdfInfoKey(mediaType) });
  return {
    iv: expanded.slice(0, 16),
    cipherKey: expanded.slice(16, 48),
    macKey: expanded.slice(48, 80),
  };
}

// ── Encryption ─────────────────────────────────────────────────────────

/**
 * AES-256-CBC encrypt a media stream for WhatsApp upload.
 *
 * Writes the encrypted file to a temp path and returns the keys and hashes
 * needed for the upload request.
 */
export async function encryptedStream(
  media: WAMediaUpload,
  mediaType: string,
  opts?: {
    logger?: { debug?: (...args: unknown[]) => void };
    saveOriginalFileIfRequired?: boolean;
  },
): Promise<EncryptedStreamResult> {
  const { stream } = await getStream(media);
  opts?.logger?.debug?.('fetched media stream');

  const mediaKey = randomBytes(32);
  const { cipherKey, iv, macKey } = await getMediaKeys(mediaKey, mediaType);

  const tmpDir = tmpdir();
  const encFilePath = join(tmpDir, `${mediaType}-${Date.now()}-enc`);

  const encWriteStream = createWriteStream(encFilePath);
  const aes = createCipheriv('aes-256-cbc', cipherKey, iv);
  const hmac = createHmac('sha256', macKey).update(iv);
  const sha256Plain = createHash('sha256');
  const sha256Enc = createHash('sha256');

  let fileLength = 0;

  const onChunk = (buff: Buffer) => {
    sha256Enc.update(buff);
    hmac.update(buff);
    encWriteStream.write(buff);
  };

  try {
    for await (const data of stream) {
      fileLength += data.length;
      sha256Plain.update(data);
      onChunk(aes.update(data));
    }
    onChunk(aes.final());

    const mac = hmac.digest().slice(0, 10);
    sha256Enc.update(mac);
    const fileSha256 = sha256Plain.digest();
    const fileEncSha256 = sha256Enc.digest();

    encWriteStream.write(mac);
    encWriteStream.end();

    // Wait for write finish
    await new Promise<void>((resolve, reject) => {
      encWriteStream.on('finish', resolve);
      encWriteStream.on('error', reject);
    });

    opts?.logger?.debug?.('encrypted data successfully');

    return {
      mediaKey,
      encFilePath,
      mac,
      fileEncSha256,
      fileSha256,
      fileLength,
    };
  } catch (error) {
    encWriteStream.destroy();
    aes.destroy();
    hmac.destroy();
    sha256Plain.destroy();
    sha256Enc.destroy();
    try {
      await fs.unlink(encFilePath);
    } catch {
      // ignore cleanup errors
    }
    throw error;
  }
}

// ── Upload ─────────────────────────────────────────────────────────────

/** URL-safe base64 encoding for upload tokens. */
function encodeBase64EncodedStringForUpload(b64: string): string {
  return encodeURIComponent(b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
}

/**
 * Factory that returns an upload function. The upload function sends an
 * encrypted media file to WhatsApp's media servers.
 */
export function getWAUploadToServer(config: {
  refreshMediaConn: (forceGet?: boolean) => Promise<MediaConnInfo>;
  logger?: { debug?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void };
  fetchAgent?: unknown;
  options?: { headers?: Record<string, string> | Array<[string, string]> };
  customUploadHosts?: Array<{ hostname: string; maxContentLengthBytes?: number }>;
}): (
  filePath: string,
  opts: {
    mediaType: string;
    fileEncSha256B64: string;
    timeoutMs?: number;
  },
) => Promise<MediaUploadResult> {
  const { refreshMediaConn, logger, customUploadHosts = [], options } = config;

  return async (filePath, { mediaType, fileEncSha256B64, timeoutMs }) => {
    let uploadInfo = await refreshMediaConn(false);
    let urls: MediaUploadResult | undefined;

    const hosts = [...customUploadHosts, ...uploadInfo.hosts];
    fileEncSha256B64 = encodeBase64EncodedStringForUpload(fileEncSha256B64);

    for (const { hostname } of hosts) {
      logger?.debug?.(`uploading to "${hostname}"`);
      const auth = encodeURIComponent(uploadInfo.auth);
      const url = `https://${hostname}${MEDIA_PATH_MAP[mediaType]}/${fileEncSha256B64}?auth=${auth}&token=${fileEncSha256B64}`;

      try {
        const stream = createReadStream(filePath);
        const headers: Record<string, string> = {
          'Content-Type': 'application/octet-stream',
          Origin: 'https://web.whatsapp.com',
        };

        if (options?.headers) {
          const optsHeaders = Array.isArray(options.headers)
            ? Object.fromEntries(options.headers)
            : options.headers;
          Object.assign(headers, optsHeaders);
        }

        const response = await fetch(url, {
          method: 'POST',
          body: stream as unknown as BodyInit,
          headers,
          signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
        } as RequestInit);

        let parsed: MediaUploadResult | undefined;
        try {
          parsed = (await response.json()) as MediaUploadResult;
        } catch {
          parsed = undefined;
        }

        if (parsed?.mediaUrl || parsed?.directPath) {
          urls = {
            mediaUrl: parsed.mediaUrl,
            directPath: parsed.directPath,
            fbid: parsed.fbid,
            ts: parsed.ts,
          };
          break;
        }

        uploadInfo = await refreshMediaConn(true);
        throw new Error(`upload failed: ${JSON.stringify(parsed)}`);
      } catch (error) {
        const isLast = hostname === hosts[hosts.length - 1]?.hostname;
        logger?.warn?.(
          `Error uploading to ${hostname} ${isLast ? '' : ', retrying...'}: ${String(error)}`,
        );
      }
    }

    if (!urls) {
      throw new Error('Media upload failed on all hosts');
    }
    return urls;
  };
}

// ── Media connection ───────────────────────────────────────────────────

/**
 * Refreshes media connection parameters (hosts, auth token, TTL).
 * Called internally by `getWAUploadToServer`; also exported for manual refresh.
 */
export async function refreshMediaConn(
  query: (
    node: unknown,
  ) => Promise<{ tag: string; attrs: Record<string, string>; content?: unknown[] }>,
  mediaConnCache: { current?: MediaConnInfo } | undefined,
  logger: { debug?: (...args: unknown[]) => void } | undefined,
  forceGet = false,
): Promise<MediaConnInfo> {
  const cached = mediaConnCache?.current;
  if (!forceGet && cached && Date.now() - cached.fetchDate.getTime() < cached.ttl * 1000) {
    return cached;
  }

  const result = await query({
    tag: 'iq',
    attrs: {
      type: 'set',
      xmlns: 'w:m',
      to: 's.whatsapp.net',
    },
    content: [{ tag: 'media_conn', attrs: {} }],
  });

  const mediaConnNode = Array.isArray(result.content)
    ? result.content.find(
        (c): c is { tag: string; attrs: Record<string, string>; content?: unknown[] } =>
          typeof c === 'object' && c !== null && (c as { tag: string }).tag === 'media_conn',
      )
    : undefined;

  if (!mediaConnNode) {
    throw new Error('No media_conn node in response');
  }

  const hosts = Array.isArray(mediaConnNode.content)
    ? mediaConnNode.content
        .filter(
          (c): c is { tag: string; attrs: Record<string, string> } =>
            typeof c === 'object' && c !== null && (c as { tag: string }).tag === 'host',
        )
        .map((h) => ({
          hostname: h.attrs.hostname as string,
          maxContentLengthBytes: Number(h.attrs.maxContentLengthBytes) || undefined,
        }))
    : [];

  const node: MediaConnInfo = {
    hosts,
    auth: mediaConnNode.attrs.auth as string,
    ttl: Number(mediaConnNode.attrs.ttl),
    fetchDate: new Date(),
  };

  if (mediaConnCache) {
    mediaConnCache.current = node;
  }

  logger?.debug?.('fetched media conn');
  return node;
}

// ── Download helpers ───────────────────────────────────────────────────

/** Build a direct URL from a directPath. */
export function getUrlFromDirectPath(directPath: string): string {
  return `https://${DEF_HOST}${directPath}`;
}

/**
 * Download and decrypt a media message from WhatsApp's CDN.
 */
export async function downloadContentFromMessage(
  {
    mediaKey,
    directPath,
    url,
  }: { mediaKey?: Uint8Array | Buffer | null; directPath?: string | null; url?: string | null },
  type: string,
  opts?: { startByte?: number; endByte?: number },
): Promise<Readable> {
  const downloadUrl = url?.startsWith('https://mmg.whatsapp.net/')
    ? url
    : directPath
      ? getUrlFromDirectPath(directPath)
      : undefined;

  if (!downloadUrl) {
    throw new Error('No valid media URL or directPath');
  }

  if (!mediaKey) {
    throw new Error('No media key provided');
  }

  const keys = await getMediaKeys(Buffer.from(mediaKey), type);
  return downloadEncryptedContent(downloadUrl, keys, opts);
}

/**
 * Download and decrypt AES-256-CBC encrypted content from a URL.
 */
export async function downloadEncryptedContent(
  downloadUrl: string,
  { cipherKey, iv }: { cipherKey: Buffer; iv: Buffer },
  opts?: { startByte?: number; endByte?: number },
): Promise<Readable> {
  const response = await fetch(downloadUrl, {
    headers: {
      Origin: 'https://web.whatsapp.com',
    },
  });

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }

  const encrypted = Buffer.from(await response.arrayBuffer());
  const decipher = createCipheriv('aes-256-cbc', cipherKey, iv);

  // Simple in-memory decrypt (for small media; large files use streaming)
  let plaintext: Buffer;
  if (opts?.startByte || opts?.endByte) {
    const start = opts.startByte ?? 0;
    const end = opts.endByte ?? encrypted.length;
    const slice = encrypted.slice(start, end);
    plaintext = Buffer.concat([decipher.update(slice), decipher.final()]);
  } else {
    plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }

  return toReadable(plaintext);
}
