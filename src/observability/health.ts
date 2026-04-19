import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { NexaWhatsMetrics } from './metrics.js';

export interface HealthSnapshot {
  status: 'ok' | 'degraded' | 'down';
  connection: string;
  queueDepth: number;
  circuitBreaker: string;
  uptimeSeconds: number;
  timestamp: string;
}

export interface HealthServerOptions {
  port: number;
  /** Hostname to bind. Default: '127.0.0.1' (localhost only). */
  host?: string;
  /** Source of truth for the health payload. */
  getSnapshot: () => HealthSnapshot;
  /** Metrics instance — /metrics route is wired only when this is provided. */
  metrics?: NexaWhatsMetrics;
}

/**
 * Tiny HTTP server exposing /health (JSON) and /metrics (Prometheus text).
 *
 * Uses Node's built-in http module — no Express dependency.
 */
export class HealthServer {
  private readonly server: Server;
  private readonly options: HealthServerOptions;
  private started = false;

  constructor(options: HealthServerOptions) {
    this.options = options;
    this.server = createServer((req, res) => this.handle(req, res));
  }

  async start(): Promise<void> {
    if (this.started) return;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      this.server.once('error', onError);
      this.server.listen(this.options.port, this.options.host ?? '127.0.0.1', () => {
        this.server.off('error', onError);
        resolve();
      });
    });
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
    this.started = false;
  }

  /** Actual bound port (useful when constructed with port: 0 for tests). */
  get port(): number {
    const addr = this.server.address();
    if (addr && typeof addr === 'object') return addr.port;
    return this.options.port;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';

    if (url === '/health' || url === '/healthz') {
      const snapshot = this.options.getSnapshot();
      const code = snapshot.status === 'ok' ? 200 : snapshot.status === 'degraded' ? 200 : 503;
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(snapshot));
      return;
    }

    if (url === '/metrics' && this.options.metrics) {
      try {
        const body = await this.options.metrics.render();
        res.writeHead(200, { 'Content-Type': this.options.metrics.contentType });
        res.end(body);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`metrics error: ${(err as Error).message}`);
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
}
