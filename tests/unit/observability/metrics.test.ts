import { Registry } from 'prom-client';
import { beforeEach, describe, expect, it } from 'vitest';
import { NexaWhatsMetrics } from '../../../src/observability/metrics.js';

describe('NexaWhatsMetrics', () => {
  let register: Registry;
  let metrics: NexaWhatsMetrics;

  beforeEach(() => {
    register = new Registry();
    metrics = new NexaWhatsMetrics({ register });
  });

  it('exposes all 7 named metrics', async () => {
    const text = await metrics.render();
    expect(text).toContain('nexawhats_messages_sent_total');
    expect(text).toContain('nexawhats_messages_received_total');
    expect(text).toContain('nexawhats_messages_failed_total');
    expect(text).toContain('nexawhats_connection_state');
    expect(text).toContain('nexawhats_send_duration_seconds');
    expect(text).toContain('nexawhats_queue_depth');
    expect(text).toContain('nexawhats_circuit_breaker_state');
  });

  it('increments messagesSent with type and priority labels', async () => {
    metrics.recordMessageSent('text', 'high');
    metrics.recordMessageSent('text', 'high');
    metrics.recordMessageSent('image', 'normal');

    const text = await metrics.render();
    expect(text).toMatch(/messages_sent_total\{type="text",priority="high"\} 2/);
    expect(text).toMatch(/messages_sent_total\{type="image",priority="normal"\} 1/);
  });

  it('increments messagesReceived with type label', async () => {
    metrics.recordMessageReceived('text');
    metrics.recordMessageReceived('text');
    metrics.recordMessageReceived('reaction');

    const text = await metrics.render();
    expect(text).toMatch(/messages_received_total\{type="text"\} 2/);
    expect(text).toMatch(/messages_received_total\{type="reaction"\} 1/);
  });

  it('increments messagesFailed with reason label', async () => {
    metrics.recordMessageFailed('rate_limited');
    metrics.recordMessageFailed('session_missing');

    const text = await metrics.render();
    expect(text).toMatch(/messages_failed_total\{reason="rate_limited"\} 1/);
    expect(text).toMatch(/messages_failed_total\{reason="session_missing"\} 1/);
  });

  it('maps connection state strings to numeric gauge values', async () => {
    metrics.setConnectionState('connected');
    let text = await metrics.render();
    expect(text).toMatch(/nexawhats_connection_state 2/);

    metrics.setConnectionState('connecting');
    text = await metrics.render();
    expect(text).toMatch(/nexawhats_connection_state 1/);

    metrics.setConnectionState('disconnected');
    text = await metrics.render();
    expect(text).toMatch(/nexawhats_connection_state 0/);

    metrics.setConnectionState('reconnecting');
    text = await metrics.render();
    expect(text).toMatch(/nexawhats_connection_state 3/);
  });

  it('ignores unknown connection states', async () => {
    metrics.setConnectionState('connected');
    metrics.setConnectionState('bogus_state');
    const text = await metrics.render();
    // Stays at 2 (connected) — didn't regress to 0.
    expect(text).toMatch(/nexawhats_connection_state 2/);
  });

  it('maps circuit breaker states', async () => {
    metrics.setCircuitBreakerState('open');
    let text = await metrics.render();
    expect(text).toMatch(/nexawhats_circuit_breaker_state 1/);

    metrics.setCircuitBreakerState('half-open');
    text = await metrics.render();
    expect(text).toMatch(/nexawhats_circuit_breaker_state 2/);

    metrics.setCircuitBreakerState('closed');
    text = await metrics.render();
    expect(text).toMatch(/nexawhats_circuit_breaker_state 0/);
  });

  it('tracks queue depth per priority', async () => {
    metrics.setQueueDepth('urgent', 3);
    metrics.setQueueDepth('normal', 10);

    const text = await metrics.render();
    expect(text).toMatch(/queue_depth\{priority="urgent"\} 3/);
    expect(text).toMatch(/queue_depth\{priority="normal"\} 10/);
  });

  it('measures send duration via startSendTimer', async () => {
    const end = metrics.startSendTimer();
    await new Promise((r) => setTimeout(r, 5));
    end();

    const text = await metrics.render();
    // At least one observation should appear in the histogram.
    expect(text).toMatch(/send_duration_seconds_count 1/);
  });

  it('record helpers are no-ops when disabled', async () => {
    const disabled = new NexaWhatsMetrics({ register: new Registry(), enabled: false });
    disabled.recordMessageSent('text', 'high');
    disabled.recordMessageFailed('x');
    disabled.setConnectionState('connected');
    disabled.setQueueDepth('urgent', 5);
    disabled.setCircuitBreakerState('open');
    const end = disabled.startSendTimer();
    end();

    const text = await disabled.render();
    // All counters/gauges remain at zero.
    expect(text).not.toMatch(/messages_sent_total\{[^}]+\}\s+[1-9]/);
    expect(text).toMatch(/nexawhats_connection_state 0/);
    expect(text).toMatch(/nexawhats_circuit_breaker_state 0/);
  });

  it('reset() zeroes every metric', async () => {
    metrics.recordMessageSent('text', 'high');
    metrics.setQueueDepth('urgent', 9);
    metrics.reset();

    const text = await metrics.render();
    expect(text).not.toMatch(/messages_sent_total\{[^}]+\}\s+[1-9]/);
  });

  it('honours a custom prefix', async () => {
    const m = new NexaWhatsMetrics({ register: new Registry(), prefix: 'mycorp_' });
    m.recordMessageSent('text', 'high');
    const text = await m.render();
    expect(text).toContain('mycorp_messages_sent_total');
    expect(text).not.toContain('nexawhats_messages_sent_total');
  });

  it('isolates metrics per custom registry', async () => {
    const m1 = new NexaWhatsMetrics({ register: new Registry() });
    const m2 = new NexaWhatsMetrics({ register: new Registry() });
    m1.recordMessageSent('text', 'high');
    const t1 = await m1.render();
    const t2 = await m2.render();
    expect(t1).toMatch(/messages_sent_total\{type="text",priority="high"\} 1/);
    expect(t2).not.toMatch(/messages_sent_total\{type="text",priority="high"\} 1/);
  });

  it('exposes the prometheus content type', () => {
    expect(metrics.contentType).toContain('text/plain');
  });
});
