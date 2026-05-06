import { Registry } from 'prom-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HealthServer, type HealthSnapshot } from '../../../src/observability/health.js';
import { NexaWhatsMetrics } from '../../../src/observability/metrics.js';

function stubSnapshot(overrides: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    status: 'ok',
    connection: 'connected',
    queueDepth: 0,
    circuitBreaker: 'closed',
    uptimeSeconds: 10,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

async function fetchText(
  port: number,
  path: string,
): Promise<{ status: number; body: string; contentType: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return {
    status: res.status,
    body: await res.text(),
    contentType: res.headers.get('content-type') ?? '',
  };
}

describe('HealthServer', () => {
  let server: HealthServer;
  let snapshot: HealthSnapshot;

  beforeEach(() => {
    snapshot = stubSnapshot();
  });

  afterEach(async () => {
    await server?.stop();
  });

  it('serves /health with JSON status=ok → 200', async () => {
    server = new HealthServer({ port: 0, getSnapshot: () => snapshot });
    await server.start();

    const { status, body, contentType } = await fetchText(server.port, '/health');
    expect(status).toBe(200);
    expect(contentType).toContain('application/json');
    const parsed = JSON.parse(body);
    expect(parsed.status).toBe('ok');
    expect(parsed.connection).toBe('connected');
  });

  it('serves /healthz as an alias', async () => {
    server = new HealthServer({ port: 0, getSnapshot: () => snapshot });
    await server.start();

    const { status, body } = await fetchText(server.port, '/healthz');
    expect(status).toBe(200);
    expect(JSON.parse(body).status).toBe('ok');
  });

  it('status=degraded returns 200', async () => {
    snapshot = stubSnapshot({ status: 'degraded' });
    server = new HealthServer({ port: 0, getSnapshot: () => snapshot });
    await server.start();

    const { status } = await fetchText(server.port, '/health');
    expect(status).toBe(200);
  });

  it('status=down returns 503', async () => {
    snapshot = stubSnapshot({ status: 'down', connection: 'disconnected' });
    server = new HealthServer({ port: 0, getSnapshot: () => snapshot });
    await server.start();

    const { status, body } = await fetchText(server.port, '/health');
    expect(status).toBe(503);
    expect(JSON.parse(body).connection).toBe('disconnected');
  });

  it('reflects live changes via the getSnapshot callback', async () => {
    let state = 'connecting';
    server = new HealthServer({
      port: 0,
      getSnapshot: () => stubSnapshot({ connection: state }),
    });
    await server.start();

    let result = await fetchText(server.port, '/health');
    expect(JSON.parse(result.body).connection).toBe('connecting');

    state = 'connected';
    result = await fetchText(server.port, '/health');
    expect(JSON.parse(result.body).connection).toBe('connected');
  });

  it('returns 404 for unknown routes', async () => {
    server = new HealthServer({ port: 0, getSnapshot: () => snapshot });
    await server.start();

    const { status } = await fetchText(server.port, '/nope');
    expect(status).toBe(404);
  });

  it('serves /metrics when a metrics instance is wired', async () => {
    const metrics = new NexaWhatsMetrics({ register: new Registry() });
    metrics.recordMessageSent('text', 'high');
    server = new HealthServer({ port: 0, getSnapshot: () => snapshot, metrics });
    await server.start();

    const { status, body, contentType } = await fetchText(server.port, '/metrics');
    expect(status).toBe(200);
    expect(contentType).toContain('text/plain');
    expect(body).toMatch(/messages_sent_total\{type="text",priority="high"\} 1/);
  });

  it('returns 404 for /metrics when no metrics are configured', async () => {
    server = new HealthServer({ port: 0, getSnapshot: () => snapshot });
    await server.start();

    const { status } = await fetchText(server.port, '/metrics');
    expect(status).toBe(404);
  });

  it('double-start is a no-op', async () => {
    server = new HealthServer({ port: 0, getSnapshot: () => snapshot });
    await server.start();
    // Should not throw EADDRINUSE — second call is guarded.
    await server.start();
    const { status } = await fetchText(server.port, '/health');
    expect(status).toBe(200);
  });

  it('stop is idempotent', async () => {
    server = new HealthServer({ port: 0, getSnapshot: () => snapshot });
    await server.start();
    await server.stop();
    await server.stop();
  });

  it('reports a useful error if the port is taken', async () => {
    server = new HealthServer({ port: 0, getSnapshot: () => snapshot });
    await server.start();

    const second = new HealthServer({
      port: server.port,
      getSnapshot: () => snapshot,
    });
    await expect(second.start()).rejects.toThrow();
  });
});
