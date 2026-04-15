import { beforeEach, describe, expect, it } from 'vitest';
import { DeadLetterQueue } from '../../../src/queue/dead-letter.js';

describe('DeadLetterQueue', () => {
  let dlq: DeadLetterQueue;

  beforeEach(() => {
    dlq = new DeadLetterQueue(5);
  });

  it('should start empty', () => {
    expect(dlq.size).toBe(0);
    expect(dlq.getAll()).toEqual([]);
  });

  it('should add dead letters', () => {
    dlq.add({
      jid: '123@s.whatsapp.net',
      content: { text: 'hello' },
      error: new Error('send failed'),
      attempts: 3,
      firstAttempt: new Date(),
      lastAttempt: new Date(),
    });
    expect(dlq.size).toBe(1);
  });

  it('should get dead letters by JID', () => {
    dlq.add({
      jid: '123@s.whatsapp.net',
      content: { text: 'a' },
      error: new Error('fail'),
      attempts: 3,
      firstAttempt: new Date(),
      lastAttempt: new Date(),
    });
    dlq.add({
      jid: '456@s.whatsapp.net',
      content: { text: 'b' },
      error: new Error('fail'),
      attempts: 3,
      firstAttempt: new Date(),
      lastAttempt: new Date(),
    });

    const result = dlq.getForJid('123@s.whatsapp.net');
    expect(result).toHaveLength(1);
    expect(result[0].jid).toBe('123@s.whatsapp.net');
  });

  it('should evict oldest when over capacity', () => {
    for (let i = 0; i < 7; i++) {
      dlq.add({
        jid: `${i}@s.whatsapp.net`,
        content: { text: `msg-${i}` },
        error: new Error('fail'),
        attempts: 3,
        firstAttempt: new Date(),
        lastAttempt: new Date(),
      });
    }
    expect(dlq.size).toBe(5);
    // Oldest (0, 1) should be evicted
    expect(dlq.getForJid('0@s.whatsapp.net')).toHaveLength(0);
    expect(dlq.getForJid('1@s.whatsapp.net')).toHaveLength(0);
    expect(dlq.getForJid('2@s.whatsapp.net')).toHaveLength(1);
  });

  it('should drain and return all items', () => {
    dlq.add({
      jid: '123@s.whatsapp.net',
      content: {},
      error: new Error('fail'),
      attempts: 3,
      firstAttempt: new Date(),
      lastAttempt: new Date(),
    });
    const drained = dlq.drain();
    expect(drained).toHaveLength(1);
    expect(dlq.size).toBe(0);
  });

  it('should clear all items', () => {
    dlq.add({
      jid: '123@s.whatsapp.net',
      content: {},
      error: new Error('fail'),
      attempts: 3,
      firstAttempt: new Date(),
      lastAttempt: new Date(),
    });
    dlq.clear();
    expect(dlq.size).toBe(0);
  });
});
