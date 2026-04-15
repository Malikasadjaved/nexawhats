import { describe, expect, it } from 'vitest';
import {
  AuthError,
  BannedError,
  CircuitBreakerOpenError,
  ConnectionError,
  ConnectionTimeoutError,
  LoggedOutError,
  MediaUploadError,
  NexaWhatsError,
  QueueFullError,
  RateLimitError,
  SendError,
  SessionCorruptedError,
} from '../../../src/errors/index.js';
import { NexaWhatsErrorCode } from '../../../src/types/errors.js';

describe('Error classes', () => {
  it('NexaWhatsError should have code and isRetryable', () => {
    const err = new NexaWhatsError('test', NexaWhatsErrorCode.CONNECTION_FAILED, true);
    expect(err.message).toBe('test');
    expect(err.code).toBe('CONNECTION_FAILED');
    expect(err.isRetryable).toBe(true);
    expect(err.name).toBe('NexaWhatsError');
    expect(err).toBeInstanceOf(Error);
  });

  it('ConnectionError should include statusCode', () => {
    const err = new ConnectionError('conn failed', 405);
    expect(err.statusCode).toBe(405);
    expect(err.isRetryable).toBe(true);
    expect(err.name).toBe('ConnectionError');
  });

  it('RateLimitError should include retryAfterMs', () => {
    const err = new RateLimitError('rate limited', 60000);
    expect(err.retryAfterMs).toBe(60000);
    expect(err.isRetryable).toBe(true);
    expect(err.code).toBe('RATE_LIMITED');
  });

  it('BannedError should not be retryable', () => {
    const err = new BannedError();
    expect(err.isRetryable).toBe(false);
    expect(err.code).toBe('BANNED');
  });

  it('LoggedOutError should not be retryable', () => {
    const err = new LoggedOutError();
    expect(err.isRetryable).toBe(false);
    expect(err.code).toBe('LOGGED_OUT');
  });

  it('ConnectionTimeoutError should include timeout', () => {
    const err = new ConnectionTimeoutError(20000);
    expect(err.message).toContain('20000ms');
    expect(err.isRetryable).toBe(true);
  });

  it('CircuitBreakerOpenError should include cooldown', () => {
    const err = new CircuitBreakerOpenError(15000);
    expect(err.cooldownRemainingMs).toBe(15000);
    expect(err.message).toContain('15s');
  });

  it('AuthError should not be retryable', () => {
    const err = new AuthError('bad creds');
    expect(err.isRetryable).toBe(false);
    expect(err.code).toBe('AUTH_FAILED');
  });

  it('SessionCorruptedError should not be retryable', () => {
    const err = new SessionCorruptedError();
    expect(err.isRetryable).toBe(false);
  });

  it('SendError should include jid and attempts', () => {
    const err = new SendError('123@s.whatsapp.net', 'send failed', 2);
    expect(err.jid).toBe('123@s.whatsapp.net');
    expect(err.attempts).toBe(2);
    expect(err.isRetryable).toBe(true);
  });

  it('SendError with 3+ attempts should not be retryable', () => {
    const err = new SendError('123@s.whatsapp.net', 'send failed', 3);
    expect(err.isRetryable).toBe(false);
  });

  it('MediaUploadError should include mediaType', () => {
    const err = new MediaUploadError('image', 'upload failed');
    expect(err.mediaType).toBe('image');
    expect(err.isRetryable).toBe(true);
  });

  it('QueueFullError should include queueSize', () => {
    const err = new QueueFullError(10000);
    expect(err.queueSize).toBe(10000);
    expect(err.message).toContain('10000');
  });
});

describe('Error inheritance', () => {
  it('all errors should be instanceof Error', () => {
    const errors = [
      new ConnectionError('test'),
      new RateLimitError('test'),
      new BannedError(),
      new LoggedOutError(),
      new AuthError('test'),
      new SendError('jid', 'test'),
      new MediaUploadError('image', 'test'),
      new QueueFullError(100),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(NexaWhatsError);
    }
  });
});
