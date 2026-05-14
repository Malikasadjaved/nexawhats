import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import type { BinaryNode } from './binary/index.js';
import { S_WHATSAPP_NET, isJidGroup, jidDecode, jidNormalizedUser } from './binary/jid.js';
import { connectOnce } from './client/connect.js';
import { type GroupOperations, makeGroupOperations } from './groups/index.js';
import {
  type MediaConnInfo,
  encryptedStream,
  getWAUploadToServer,
  refreshMediaConn,
} from './messages/media.js';
import { extractText, isGroupMessage } from './messages/receive.js';
import { cleanMessage, decryptMessageNode, isRealMessage } from './messages/recv.js';
import { makeMessageRelay } from './messages/send-relay.js';
import { MessageSender } from './messages/send.js';
import { type Context, type Middleware, MiddlewarePipeline } from './middleware/index.js';
import { HealthServer, type HealthSnapshot, NexaWhatsMetrics } from './observability/index.js';
import {
  DEFAULT_BROWSER,
  DEFAULT_VERSION,
  fetchLatestVersion,
  generateLoginNode,
  generateRegistrationNode,
} from './proto/payload.js';
import { MessageQueue } from './queue/index.js';
import { type SignalRepository, makeLibSignalRepository } from './signal/libsignal.js';
import { CircuitBreaker } from './socket/circuit-breaker.js';
import { buildLinkCodeCompanionFinish, buildPairDeviceIQ, generatePairingCode, processPairSuccess } from './socket/pairing.js';
import { ConnectionStateMachine } from './socket/state-machine.js';
import type { AuthStore } from './store/interface.js';
import type { AuthenticationCreds, AuthenticationState } from './types/auth.js';
import type { NexaWhatsEventMap } from './types/events.js';
import type { MediaUploadCallback, WAMessage, WAMessageUpdate } from './types/message.js';
import type { AnyMessageContent, MessagePriority } from './types/message.js';
import type { ClientConfig, ConnectionState } from './types/socket.js';
import { initAuthCreds } from './utils/auth.js';
import { Curve, generateMessageId } from './utils/crypto.js';
import { silentLogger } from './utils/logger.js';
import { uploadPreKeysToServer } from './utils/pre-key-manager.js';

/**
 * NexaWhats client — the main entry point.
 */
export class NexaWhatsClient extends EventEmitter {
  readonly config: ClientConfig;
  readonly connection: ConnectionStateMachine;
  readonly circuitBreaker: CircuitBreaker;
  readonly queue: MessageQueue;
  readonly sender: MessageSender;
  readonly middleware: MiddlewarePipeline;
  readonly metrics: NexaWhatsMetrics;
  private healthServer: HealthServer | null = null;
  private readonly startedAt = Date.now();
  private store: AuthStore | null = null;
  private stopReconnect = false;
  private disposeConnect: (() => void) | null = null;
  private qrTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Live-connection state (populated after successful connect) ──────
  private signalRepository: SignalRepository | null = null;
  private messageRelay: ReturnType<typeof makeMessageRelay> | null = null;
  groupOps: GroupOperations | null = null;

  constructor(config: ClientConfig) {
    super();
    this.config = config;

    this.metrics = new NexaWhatsMetrics({
      enabled: config.metrics?.prometheus ?? false,
    });

    this.connection = new ConnectionStateMachine();
    this.connection.on('transition', (_from, to) => {
      this.metrics.setConnectionState(to);
      this.emit('connection.update', {
        connection: to,
      } satisfies Partial<ConnectionState>);
    });
    this.metrics.setConnectionState(this.connection.state);

    this.circuitBreaker = new CircuitBreaker(config.circuitBreaker);
    this.circuitBreaker.on('state-change', (event) => {
      const next = (event as { state?: string }).state;
      if (next) this.metrics.setCircuitBreakerState(next);
      this.emit('circuit-breaker.state-change', event);
    });

    this.queue = new MessageQueue({
      messagesPerMinute: config.queue?.messagesPerMinute,
      humanLikeTiming: config.queue?.humanLikeTiming,
      maxRetries: config.queue?.maxRetries,
    });

    this.sender = new MessageSender();
    this.sender.setQueue(this.queue);

    this.middleware = new MiddlewarePipeline();
  }

  /** Register middleware */
  use(middleware: Middleware): this {
    this.middleware.use(middleware);
    return this;
  }

  /** Set the auth store */
  setStore(store: AuthStore): this {
    this.store = store;
    return this;
  }

  async send(
    jid: string,
    content: AnyMessageContent,
    priority: MessagePriority = 'normal',
  ): Promise<unknown> {
    return this.sender.send(jid, content, priority);
  }

  // ── Connect ──────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.stopReconnect = false;
    const logger: Logger = (this.config.logger as Logger | undefined) ?? silentLogger;

    if (this.config.metrics?.prometheus && this.config.metrics.port) {
      this.healthServer = new HealthServer({
        port: this.config.metrics.port,
        getSnapshot: () => this.snapshot(),
        metrics: this.metrics,
      });
      await this.healthServer.start();
    }

    const creds: AuthenticationCreds = this.config.auth.creds?.noiseKey
      ? this.config.auth.creds
      : (initAuthCreds() as AuthenticationCreds);

    // Keep this.config.auth.creds in sync so external consumers (e.g. re-auth
    // scripts) can read pairingCode / me after a fresh init.
    if (this.config.auth.creds !== creds) {
      this.config.auth.creds = creds;
    }

    // Only generate a pairing code for fresh (unregistered) devices
    if (!creds.pairingCode && !creds.registered && this.config.phoneNumber) {
      creds.pairingCode = this.config.customPairingCode ?? generatePairingCode();
      creds.me = {
        id: `${this.config.phoneNumber}@s.whatsapp.net`,
        name: '~',
      };
      const code = creds.pairingCode;
      console.log(
        '\n' +
        '══════════════════════════════════════════════\n' +
        '  Pairing code: ' + code + '\n' +
        '  Enter this code in WhatsApp:\n' +
        '  Settings → Linked Devices → Link a Device\n' +
        '══════════════════════════════════════════════\n',
      );
      logger.info({ pairingCode: code }, 'pairing code generated — enter on phone');
    }

    const browser = (this.config.browser ?? DEFAULT_BROWSER) as readonly [string, string, string];
    let version: readonly [number, number, number];
    try {
      version = await fetchLatestVersion();
    } catch {
      logger.warn('failed to fetch latest version, using default');
      version = this.config.version ?? DEFAULT_VERSION;
    }
    const connectTimeoutMs = this.config.connectTimeoutMs ?? 20_000;
    const keepAliveIntervalMs = this.config.keepAliveIntervalMs ?? 30_000;

    const payloadConfig = { version, browser, countryCode: 'US' };
    const phoneNumber = this.config.phoneNumber;

    // ── Shared mutable refs (populated after successful connect) ──
    let sendNodeRef: ((node: BinaryNode) => Promise<void>) | null = null;

    // IQ response resolver — maps stanza id → promise handlers
    const pendingQueries = new Map<
      string,
      {
        resolve: (node: BinaryNode) => void;
        reject: (err: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();

    // Create signal repository from auth state
    this.signalRepository = makeLibSignalRepository(
      this.config.auth,
      logger.child({ class: 'signal' }),
    );

    let backoffIdx = 0;
    const maxBackoff = this.config.reconnect?.maxRetries ?? 10;
    const backoffDelays = this.config.reconnect?.backoffDelays ?? [
      1000, 2000, 4000, 8000, 16000, 30000,
    ];

    while (!this.stopReconnect) {
      if (!this.circuitBreaker.isAllowed) {
        const waitMs = this.circuitBreaker.cooldownRemainingMs;
        if (waitMs > 0) {
          await new Promise((r) => setTimeout(r, waitMs));
        }
        continue;
      }

      try {
        this.connection.transition('connecting');

        const meId = creds.me?.id ?? '';
        const isLogin = !!(meId && creds.registered);
        const clientPayload = isLogin
          ? generateLoginNode(meId, payloadConfig)
          : generateRegistrationNode(creds, payloadConfig);

        const ephemeralKeyPair = Curve.generateKeyPair();
        let pairSuccessReceived = false;
        let loginResolve: ((outcome: 'success' | 'failure' | 'pair-success') => void) | null = null;
        const loginOutcome = new Promise<'success' | 'failure' | 'pair-success'>((resolve) => {
          loginResolve = resolve;
        });

        // Track unexpected transport close so loginOutcome doesn't hang
        let closeReported = false;
        const onUnexpectedClose = (reason: string): void => {
          if (closeReported) return;
          closeReported = true;
          logger.warn({ reason }, 'transport closed unexpectedly');
          loginResolve?.(pairSuccessReceived || creds.registered ? 'pair-success' : 'failure');
        };

        const result = await connectOnce({
          creds,
          ephemeralKeyPair,
          clientPayload,
          onFrame: async (node) => {
            const { tag } = node;
            const attrs: Record<string, string> = (node.attrs ?? {}) as Record<string, string>;

            // ── Login success ─────────────────────────────────
            if (tag === 'success') {
              closeReported = true; // suppress unexpected-close after success
              logger.info('login success');
              creds.registered = true;
              if (attrs.lid) {
                creds.me = { ...creds.me, id: creds.me?.id ?? '', lid: attrs.lid };
              }
              this.connection.transition('connected');
              this.circuitBreaker.recordSuccess();
              const sn = result.sendNode;
              const myLid = attrs.lid;
              const myPn = creds.me?.id;
              if (sn && myPn) {
                const pq = pendingQueries;
                void (async () => {
                  try {
                    await uploadPreKeysToServer(sn, pq, creds, this.config.auth.keys, logger);
                    this.emit('creds.update', creds);
                    logger.info('post-login pre-keys uploaded');
                  } catch (err) {
                    logger.warn({ err }, 'post-login pre-key upload failed');
                  }
                  try {
                    await sn({
                      tag: 'iq',
                      attrs: { id: generateMessageId(), to: S_WHATSAPP_NET, type: 'set', xmlns: 'passive' },
                      content: [{ tag: 'active', attrs: {} }],
                    });
                    logger.info('passive active IQ sent');
                  } catch {
                    // best effort
                  }
                  if (myLid && this.signalRepository) {
                    try {
                      await this.signalRepository.lidMapping.storeLIDPNMappings([{ lid: myLid, pn: myPn }]);
                      const decoded = jidDecode(myPn);
                      if (decoded) {
                        await this.config.auth.keys.set({
                          'device-list': { [decoded.user]: [String(decoded.device ?? 0)] },
                        });
                        await this.signalRepository.migrateSession(myPn, myLid);
                        logger.info({ myPn, myLid }, 'LID session + device list stored');
                      }
                    } catch (err) {
                      logger.warn({ err }, 'LID mapping/migration failed');
                    }
                  }
                })();
              }
              loginResolve?.('success');
              return;
            }

            // ── Login failure ─────────────────────────────────
            if (tag === 'failure') {
              closeReported = true;
              const reason = attrs.reason ?? 'unknown';
              const reasonCode = Number(reason);
              logger.error({ reason }, 'login failure');
              if (reasonCode === 401 || reasonCode === 403 || reasonCode === 405) {
                this.stopReconnect = true;
                logger.error({ reasonCode }, 'fatal disconnect — not reconnecting');
              }
              this.connection.transition('disconnected');
              if (this.qrTimer) {
                clearTimeout(this.qrTimer);
                this.qrTimer = null;
              }
              setTimeout(() => result.dispose(), 0);
              loginResolve?.('failure');
              return;
            }

            // ── Stream error ──────────────────────────────────
            if (tag === 'stream:error') {
              closeReported = true;
              const text = Array.isArray(node.content)
                ? ((node.content[0] as { tag?: string })?.tag ?? 'unknown')
                : 'unknown';
              if (pairSuccessReceived || creds.registered) {
                logger.debug({ text }, 'stream error after login (expected restart)');
              } else {
                logger.error({ text }, 'stream error');
              }
              this.connection.transition('disconnected');
              if (this.qrTimer) {
                clearTimeout(this.qrTimer);
                this.qrTimer = null;
              }
              setTimeout(() => result.dispose(), 0);
              loginResolve?.(pairSuccessReceived ? 'pair-success' : 'failure');
              return;
            }

            // ── xmlstreamend — server terminated connection ────
            if (tag === 'xmlstreamend') {
              closeReported = true;
              logger.warn('server terminated connection (xmlstreamend)');
              this.connection.transition('disconnected');
              setTimeout(() => result.dispose(), 0);
              loginResolve?.(pairSuccessReceived || creds.registered ? 'pair-success' : 'failure');
              return;
            }

            // ── QR pair-device ────────────────────────────────
            if (tag === 'iq' && attrs.type === 'set') {
              const content = Array.isArray(node.content) ? node.content : [];
              const pairDevice = content.find(
                (c) =>
                  typeof c === 'object' &&
                  c !== null &&
                  (c as { tag?: string }).tag === 'pair-device',
              );
              if (pairDevice) {
                // Acknowledge the pair-device IQ first
                result
                  .sendNode({
                    tag: 'iq',
                    attrs: {
                      to: S_WHATSAPP_NET,
                      type: 'result',
                      id: attrs.id,
                    },
                  })
                  .catch((err: unknown) => {
                    logger.error({ err }, 'pair-device ack failed');
                  });

                const noiseKeyB64 = Buffer.from(creds.noiseKey.public).toString('base64');
                const identityKeyB64 = Buffer.from(creds.signedIdentityKey.public).toString(
                  'base64',
                );
                const advB64 = creds.advSecretKey;

                const pdContent = Array.isArray((pairDevice as { content?: unknown[] }).content)
                  ? ((pairDevice as { content: unknown[] }).content as Array<{
                      tag?: string;
                      content?: unknown;
                    }>)
                  : [];
                const refNodes = pdContent.filter((c) => c.tag === 'ref');

                const emitNextQR = () => {
                  if (!refNodes.length) {
                    logger.warn('QR refs exhausted');
                    return;
                  }
                  const refNode = refNodes.shift();
                  const ref = Buffer.isBuffer(refNode!.content)
                    ? refNode!.content.toString('utf-8')
                    : String(refNode!.content ?? '');
                  const qr = [ref, noiseKeyB64, identityKeyB64, advB64].join(',');
                  this.emit('connection.update', {
                    qr,
                    connection: this.connection.state,
                  });
                  if (refNodes.length > 0) {
                    this.qrTimer = setTimeout(emitNextQR, 20_000);
                  }
                };
                emitNextQR();

                // Only send pairing-code IQ if we're NOT already registered.
                // An already-paired session with phoneNumber set would
                // regenerate a pairing code and overwrite creds.me, causing
                // a 401 on the next login attempt.
                if (phoneNumber && creds.pairingCode && !creds.registered) {
                  buildPairDeviceIQ({
                    phoneNumber,
                    creds,
                    browser,
                  })
                    .then((pairIQ) => {
                      return result.sendNode(pairIQ);
                    })
                    .then(() => {
                      logger.info('pairing code IQ sent');
                    })
                    .catch((err: unknown) => {
                      logger.error({ err }, 'buildPairDeviceIQ/send failed');
                    });
                }
                return;
              }

              // ── downgrade_webclient — multi-device not enrolled ──
              const downgrade = content.find(
                (c) =>
                  typeof c === 'object' &&
                  c !== null &&
                  (c as { tag?: string }).tag === 'downgrade_webclient',
              );
              if (downgrade) {
                logger.error('multi-device beta not joined — downgrade_webclient received');
                this.stopReconnect = true;
                loginResolve?.('failure');
                return;
              }
            }

            // ── Pair-success ──────────────────────────────────
            if (tag === 'iq') {
              const content = Array.isArray(node.content) ? node.content : [];
              const pairSuccess = content.find(
                (c) =>
                  typeof c === 'object' &&
                  c !== null &&
                  (c as { tag?: string }).tag === 'pair-success',
              );
              if (pairSuccess) {
                logger.debug('pair success recv');
                try {
                  const { creds: updated, reply } = processPairSuccess(node, creds);
                  Object.assign(creds, updated);
                  creds.registered = true;
                  this.emit('creds.update', creds);
                  this.emit('connection.update', {
                    isNewLogin: true,
                    qr: undefined,
                    connection: this.connection.state,
                  });
                  result.sendNode(reply).catch((err: unknown) => {
                    logger.error({ err }, 'pair-success reply failed');
                  });
                  pairSuccessReceived = true;
                  if (this.qrTimer) {
                    clearTimeout(this.qrTimer);
                    this.qrTimer = null;
                  }
                } catch (err) {
                  logger.error({ err }, 'error in pairing');
                  throw err;
                }
                loginResolve?.('pair-success');
                return;
              }
            }

            // ── IQ response (resolve pending queries) ─────────
            if (tag === 'iq') {
              const pending = pendingQueries.get(attrs.id);
              if (pending) {
                clearTimeout(pending.timer);
                pendingQueries.delete(attrs.id);
                logger.debug({ id: attrs.id, type: attrs.type, pendingCount: pendingQueries.size }, 'resolved pending IQ query');
                if (attrs.type === 'error') {
                  pending.reject(new Error(`IQ error (${attrs.id}): ${JSON.stringify(attrs)}`));
                } else {
                  pending.resolve(node);
                }
                return;
              }
              logger.debug({ id: attrs.id, type: attrs.type, pendingCount: pendingQueries.size }, 'unmatched IQ received (no pending query)');
              return;
            }

            // ── ib stanzas (edge_routing, offline, etc.) ──────
            if (tag === 'ib') {
              const content = Array.isArray(node.content) ? node.content : [];
              for (const child of content) {
                if (typeof child !== 'object' || child === null) continue;
                const c = child as BinaryNode;

                if (c.tag === 'edge_routing') {
                  const routingInfo = Array.isArray(c.content)
                    ? (c.content as BinaryNode[]).find((cc) => cc.tag === 'routing_info')
                    : undefined;
                  if (routingInfo?.content && Buffer.isBuffer(routingInfo.content)) {
                    creds.routingInfo = routingInfo.content;
                    this.emit('creds.update', creds);
                    logger.info('edge_routing stored');
                  }
                }

                if (c.tag === 'offline') {
                  const count = +(c.attrs.count || 0);
                  logger.info({ count }, 'handled offline messages/notifications');
                  this.emit('connection.update', { receivedPendingNotifications: true });
                }

                if (c.tag === 'offline_preview') {
                  logger.info('offline preview received, requesting batch');
                  result.sendNode({
                    tag: 'ib',
                    attrs: {},
                    content: [{ tag: 'offline_batch', attrs: { count: '100' } }],
                  }).catch((err: unknown) => {
                    logger.error({ err }, 'offline_batch send failed');
                  });
                }
              }
              return;
            }

            // ── Message stanza ────────────────────────────────
            if (tag === 'message') {
              logger.info({ attrs: node.attrs }, 'MSG stanza received');
              void this.handleMessageStanza(node);
              return;
            }

            // ── Receipt stanza ────────────────────────────────
            if (tag === 'receipt') {
              this.handleReceiptStanza(node, attrs);
              return;
            }

            // ── Pairing-code companion notification ──────────
            if (tag === 'notification' && attrs.type === 'link_code_companion_reg') {
              logger.info('link_code_companion_reg notification received — completing pairing');
              // Mark pairing as in-progress immediately so that if the
              // server sends xmlstreamend before our async handler
              // completes, the reconnect still goes through.
              pairSuccessReceived = true;
              void (async () => {
                try {
                  const myJid = creds.me?.id ?? `${phoneNumber}@s.whatsapp.net`;
                  const iqId = generateMessageId();
                  const { node: finishIq, advSecretKey } = await buildLinkCodeCompanionFinish(
                    node,
                    creds,
                    myJid,
                    iqId,
                  );

                  // Send companion_finish and wait for server response
                  const responsePromise = new Promise<BinaryNode>((resolve, reject) => {
                    const timer = setTimeout(() => {
                      pendingQueries.delete(iqId);
                      reject(new Error('companion_finish IQ timeout'));
                    }, 30_000);
                    pendingQueries.set(iqId, { resolve, reject, timer });
                  });

                  await result.sendNode(finishIq);
                  await responsePromise; // wait for server ack

                  // Server acknowledged — now update creds
                  creds.advSecretKey = advSecretKey;
                  creds.registered = true;
                  creds.pairingCode = undefined;
                  if (this.qrTimer) {
                    clearTimeout(this.qrTimer);
                    this.qrTimer = null;
                  }
                  this.emit('creds.update', creds);
                  this.emit('connection.update', {
                    isNewLogin: true,
                    qr: undefined,
                    connection: this.connection.state,
                  });
                  logger.info('link_code_companion_reg pairing complete — waiting for server restart');
                } catch (err) {
                  pairSuccessReceived = false;
                  logger.error({ err }, 'link_code_companion_reg processing failed');
                  loginResolve?.('failure');
                }
              })();
              return;
            }

            // ── Notification stanza (group events, etc.) ──────
            if (tag === 'notification') {
              this.handleNotificationStanza(node, attrs);
              return;
            }
          },
          logger: logger.child({ class: 'connect' }),
          browser: [...browser] as [string, string, string],
          version: [...version] as [number, number, number],
          connectTimeoutMs,
          keepAliveIntervalMs,
          onUnexpectedClose,
        });

        this.disposeConnect = result.dispose;

        // ── Populate mutable refs ────────────────────────────
        sendNodeRef = result.sendNode;

        // ── IQ query helper ──────────────────────────────────
        const query = async (node: BinaryNode): Promise<BinaryNode> => {
          const sn = sendNodeRef;
          if (!sn) throw new Error('sendNode not available');
          const id = (node.attrs.id as string) || generateMessageId();
          node.attrs.id = id;
          return new Promise<BinaryNode>((resolve, reject) => {
            const timer = setTimeout(() => {
              pendingQueries.delete(id);
              reject(new Error(`IQ query timeout: ${id}`));
            }, 30_000);
            pendingQueries.set(id, { resolve, reject, timer });
            sn(node).catch((err) => {
              clearTimeout(timer);
              pendingQueries.delete(id);
              reject(err);
            });
          });
        };

        // ── Media upload callback ────────────────────────────
        const mediaConnCache: { current?: MediaConnInfo } = {};
        const mediaLogger = logger.child({ class: 'media' });
        let waUploadToServer: MediaUploadCallback | undefined;

        if (query) {
          waUploadToServer = async (media, mediaType, _opts) => {
            const { mediaKey, encFilePath, fileEncSha256, fileSha256, fileLength } =
              await encryptedStream(media, mediaType, { logger: mediaLogger });

            const uploadFn = getWAUploadToServer({
              refreshMediaConn: (force) =>
                refreshMediaConn(
                  query as (node: unknown) => Promise<{
                    tag: string;
                    attrs: Record<string, string>;
                    content?: unknown[];
                  }>,
                  mediaConnCache,
                  mediaLogger,
                  force,
                ),
              logger: mediaLogger,
            });

            const fileEncSha256B64 = fileEncSha256.toString('base64');
            const uploadResult = await uploadFn(encFilePath, {
              mediaType,
              fileEncSha256B64,
            });

            const { promises: fs } = await import('node:fs');
            try {
              await fs.unlink(encFilePath);
            } catch {
              // best-effort cleanup
            }

            const result: Awaited<ReturnType<MediaUploadCallback>> = {
              ...uploadResult,
              mediaKey,
              fileEncSha256,
              fileSha256,
              fileLength,
            };
            return result;
          };
        }

        // ── Message relay ────────────────────────────────────
        const authState: AuthenticationState = {
          creds,
          keys: this.config.auth.keys,
        };
        this.messageRelay = makeMessageRelay({
          sendNode: result.sendNode,
          signalRepository: this.signalRepository,
          auth: authState,
          logger: logger.child({ class: 'relay' }),
          query,
          waUploadToServer,
        });

        const directSend = async (
          jid: string,
          content: AnyMessageContent,
        ): Promise<WAMessage | undefined> => {
          return this.messageRelay?.sendMessage(jid, content);
        };
        this.sender.setDirectSendFn(directSend);
        this.queue.setSendFn(async (jid: string, content: AnyMessageContent) => {
          return this.messageRelay?.sendMessage(jid, content);
        });

        // ── Group operations ─────────────────────────────────
        this.groupOps = makeGroupOperations({ query });

        // ── Post-connect ─────────────────────────────────────
        logger.info('waiting for login outcome...');
        const outcome = await loginOutcome;
        logger.info({ outcome }, 'login outcome received');

        if (outcome === 'pair-success') {
          logger.info('pairing complete, server will close connection for reconnect...');
          this.connection.transition('reconnecting');
          setTimeout(() => result.dispose(), 0);
          continue;
        }

        if (outcome === 'failure') {
          logger.error('login/registration failed');
          this.connection.transition('disconnected');
          if (this.stopReconnect) return;
          continue;
        }

        // outcome === 'success' — connection is live
        backoffIdx = 0;
        return;
      } catch (err) {
        this.circuitBreaker.recordFailure();
        logger.error({ err }, 'connect attempt failed');

        if (backoffIdx < maxBackoff) {
          const delay = backoffDelays[backoffIdx] ?? backoffDelays[backoffDelays.length - 1];
          logger.info({ delay, attempt: backoffIdx + 1 }, 'reconnecting...');
          this.connection.transition('reconnecting');
          await new Promise((r) => setTimeout(r, delay));
          backoffIdx++;
        } else {
          logger.error('max reconnect attempts exhausted');
          this.connection.transition('disconnected');
          throw err;
        }
      }
    }
  }

  /** Disconnect gracefully. */
  async disconnect(): Promise<void> {
    this.stopReconnect = true;
    if (this.qrTimer) {
      clearTimeout(this.qrTimer);
      this.qrTimer = null;
    }
    if (this.disposeConnect) {
      this.disposeConnect();
      this.disposeConnect = null;
    }
    if (this.connection.isConnected || this.connection.isConnecting) {
      this.connection.reset();
    }
    this.queue.clear();
    if (this.healthServer) {
      await this.healthServer.stop();
      this.healthServer = null;
    }
    this.messageRelay = null;
    this.groupOps = null;
  }

  /** Snapshot of runtime state for /health. */
  snapshot(): HealthSnapshot {
    const state = this.connection.state;
    const status: HealthSnapshot['status'] =
      state === 'connected' ? 'ok' : state === 'disconnected' ? 'down' : 'degraded';
    return {
      status,
      connection: state,
      queueDepth: this.queue.depth,
      circuitBreaker: this.circuitBreaker.state,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      timestamp: new Date().toISOString(),
    };
  }

  async processMessage(message: WAMessage): Promise<void> {
    const jid = message.key.remoteJid ?? '';

    const ctx: Context = {
      message,
      jid,
      senderName: message.pushName ?? undefined,
      isGroup: isGroupMessage(message),
      text: extractText(message),
      timestamp: message.messageTimestamp ?? Math.floor(Date.now() / 1000),
      store: this.store as AuthStore,
      reply: async (content: AnyMessageContent) => {
        await this.send(jid, content, 'high');
      },
      resolveLID: async (lid: string) => {
        return lid;
      },
      state: {},
    };

    await this.middleware.execute(ctx);
  }

  get isConnected(): boolean {
    return this.connection.isConnected;
  }

  get connectionState(): string {
    return this.connection.state;
  }

  get queueDepth(): number {
    return this.queue.depth;
  }

  // ── Private stanza handlers ─────────────────────────────────────

  private async handleMessageStanza(node: BinaryNode): Promise<void> {
    const logger: Logger = (this.config.logger as Logger | undefined) ?? silentLogger;

    const creds = this.config.auth.creds;
    const meId = creds.me?.id ?? '';
    const meLid = creds.me?.lid;

    const fromJid = (node.attrs.from || node.attrs.participant) as string | undefined;
    if (fromJid && this.config.shouldIgnoreJid?.(jidNormalizedUser(fromJid))) {
      return;
    }

    if (!this.signalRepository) {
      logger.warn('no signal repository — cannot decrypt message');
      return;
    }

    const decryptable = decryptMessageNode(
      node,
      meId,
      meLid,
      this.signalRepository,
      logger.child({ class: 'recv' }),
    );

    try {
      await decryptable.decrypt();
      cleanMessage(decryptable.fullMessage, meId, meLid);

      const message = decryptable.fullMessage;
      const content = message.message;

      this.emit('messages.upsert', {
        messages: [message],
        type: 'notify',
      });

      if (content?.reactionMessage) {
        const rxn = content.reactionMessage;
        const rxnKey = rxn.key;
        if (rxnKey) {
          this.emit('messages.reaction', [
            {
              key: {
                remoteJid: rxnKey.remoteJid,
                fromMe: rxnKey.fromMe,
                id: rxnKey.id,
                participant: rxnKey.participant,
              },
              reaction: { text: rxn.text ?? '' },
            },
          ]);
        }
      }

      if (content?.pollUpdateMessage) {
        const update: WAMessageUpdate = {
          key: message.key,
          update: { message: content },
        };
        this.emit('messages.update', [update]);
      }

      if (content?.protocolMessage) {
        const pm = content.protocolMessage;
        if (pm.type !== undefined && pm.key) {
          const update: WAMessageUpdate = {
            key: {
              remoteJid: pm.key.remoteJid,
              fromMe: pm.key.fromMe,
              id: pm.key.id,
              participant: pm.key.participant,
            },
            update: {
              message: content,
              messageStubType: pm.type ?? undefined,
            },
          };
          this.emit('messages.update', [update]);
        }
      }

      const meta = message as unknown as Record<string, unknown>;
      if (meta.historySyncData) {
        try {
          this.emit('messaging-history.set', {
            ...(meta.historySyncData as Record<string, unknown>),
            isLatest: true,
          });
        } catch (err) {
          logger.error({ err }, 'failed to emit history sync data');
        }
        meta.historySyncData = undefined;
      }

      if (meta.appStateSyncKeys) {
        const syncKeys = meta.appStateSyncKeys as Array<{
          keyId?: string;
          keyData?: Uint8Array;
        }>;
        try {
          const keys = this.config.auth.keys;
          const newKeys: string[] = [];
          const keyData: Record<string, Uint8Array> = {};
          for (const { keyId, keyData: kd } of syncKeys) {
            if (keyId && kd) {
              keyData[keyId] = kd;
              newKeys.push(keyId);
            }
          }
          if (newKeys.length) {
            await keys.set({ 'app-state-sync-key': keyData });
            logger.info({ newKeys }, 'stored app state sync keys');
          }
        } catch (err) {
          logger.error({ err }, 'failed to store app state sync keys');
        }
        meta.appStateSyncKeys = undefined;
      }

      if (isRealMessage(message)) {
        await this.processMessage(message);
      }
    } catch (err) {
      logger.error({ err, stanzaId: node.attrs.id }, 'message stanza processing failed');
    }
  }

  private handleReceiptStanza(_node: BinaryNode, attrs: Record<string, string>): void {
    const id = attrs.id;
    const type = attrs.type;
    const from = attrs.from;
    const participant = attrs.participant;
    const recipient = attrs.recipient;
    const t = attrs.t ? Number(attrs.t) : undefined;

    if (!id || !type) return;

    const key = {
      remoteJid: from ?? recipient ?? '',
      fromMe: !from || from === this.config.auth.creds.me?.id,
      id,
      participant: participant ?? undefined,
    };

    if (type === 'read' || type === 'read-self') {
      const updates: WAMessageUpdate[] = [
        {
          key,
          update: {
            status: 'READ',
          },
        },
      ];
      this.emit('messages.update', updates);

      this.emit('message-receipt.update', [
        {
          key,
          receipt: {
            userJid: participant ?? from ?? '',
            readTimestamp: t,
            receiptTimestamp: t ?? Math.floor(Date.now() / 1000),
          },
        },
      ]);
    } else if (type === 'sender' || type === 'delivery') {
      this.emit('message-receipt.update', [
        {
          key,
          receipt: {
            userJid: participant ?? from ?? '',
            receiptTimestamp: t ?? Math.floor(Date.now() / 1000),
          },
        },
      ]);
    }
  }

  private handleNotificationStanza(node: BinaryNode, attrs: Record<string, string>): void {
    const logger: Logger = (this.config.logger as Logger | undefined) ?? silentLogger;

    const from = attrs.from;
    const type = attrs.type;

    logger.debug({ from, type, attrs }, 'notification stanza');

    if (from && isJidGroup(from)) {
      const content = Array.isArray(node.content) ? node.content : [];

      for (const child of content) {
        if (typeof child !== 'object' || child === null) continue;
        const c = child as BinaryNode;

        switch (c.tag) {
          case 'subject': {
            this.emit('groups.update', [
              {
                id: from,
                subject: c.attrs.subject as string,
                subjectTime: Number(c.attrs.t) || undefined,
                subjectOwner: c.attrs.s_o ? jidNormalizedUser(c.attrs.s_o as string) : undefined,
              },
            ]);
            break;
          }
          case 'add':
          case 'remove':
          case 'promote':
          case 'demote': {
            const participants = Array.isArray(c.content)
              ? (c.content as BinaryNode[]).map((p) => ({
                  id: p.attrs.jid as string,
                  isAdmin: (p.attrs.type as string) === 'admin',
                  isSuperAdmin: (p.attrs.type as string) === 'superadmin',
                }))
              : [];
            this.emit('group-participants.update', {
              id: from,
              author: c.attrs.author ? jidNormalizedUser(c.attrs.author as string) : '',
              participants,
              action: c.tag,
            });
            break;
          }
          case 'ephemeral': {
            this.emit('groups.update', [
              {
                id: from,
                ephemeralDuration: Number(c.attrs.expiration) || undefined,
              },
            ]);
            break;
          }
          case 'not_ephemeral': {
            this.emit('groups.update', [{ id: from, ephemeralDuration: undefined }]);
            break;
          }
          default:
            break;
        }
      }
      return;
    }

    logger.debug({ attrs }, 'unhandled notification type');
  }
}

// Typed event helpers
export type TypedOn = <T extends keyof NexaWhatsEventMap>(
  event: T,
  listener: (arg: NexaWhatsEventMap[T]) => void,
) => NexaWhatsClient;

export type TypedOff = <T extends keyof NexaWhatsEventMap>(
  event: T,
  listener: (arg: NexaWhatsEventMap[T]) => void,
) => NexaWhatsClient;

export type TypedEmit = <T extends keyof NexaWhatsEventMap>(
  event: T,
  arg: NexaWhatsEventMap[T],
) => boolean;

export function createClient(config: ClientConfig): NexaWhatsClient {
  return new NexaWhatsClient(config);
}
