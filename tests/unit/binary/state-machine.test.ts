import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionStateMachine } from '../../../src/socket/state-machine.js';

describe('ConnectionStateMachine', () => {
  let sm: ConnectionStateMachine;

  beforeEach(() => {
    sm = new ConnectionStateMachine();
  });

  it('should start in disconnected state', () => {
    expect(sm.state).toBe('disconnected');
    expect(sm.isConnected).toBe(false);
    expect(sm.isConnecting).toBe(false);
  });

  describe('valid transitions', () => {
    it('disconnected → connecting', () => {
      sm.transition('connecting');
      expect(sm.state).toBe('connecting');
      expect(sm.isConnecting).toBe(true);
    });

    it('connecting → connected', () => {
      sm.transition('connecting');
      sm.transition('connected');
      expect(sm.state).toBe('connected');
      expect(sm.isConnected).toBe(true);
    });

    it('connecting → reconnecting', () => {
      sm.transition('connecting');
      sm.transition('reconnecting');
      expect(sm.state).toBe('reconnecting');
    });

    it('connecting → disconnected', () => {
      sm.transition('connecting');
      sm.transition('disconnected');
      expect(sm.state).toBe('disconnected');
    });

    it('connected → reconnecting', () => {
      sm.transition('connecting');
      sm.transition('connected');
      sm.transition('reconnecting');
      expect(sm.state).toBe('reconnecting');
    });

    it('connected → disconnected', () => {
      sm.transition('connecting');
      sm.transition('connected');
      sm.transition('disconnected');
      expect(sm.state).toBe('disconnected');
    });

    it('reconnecting → connecting', () => {
      sm.transition('connecting');
      sm.transition('reconnecting');
      sm.transition('connecting');
      expect(sm.state).toBe('connecting');
    });

    it('reconnecting → disconnected', () => {
      sm.transition('connecting');
      sm.transition('reconnecting');
      sm.transition('disconnected');
      expect(sm.state).toBe('disconnected');
    });
  });

  describe('invalid transitions', () => {
    it('should throw on disconnected → connected', () => {
      expect(() => sm.transition('connected')).toThrow('Invalid state transition');
    });

    it('should throw on disconnected → reconnecting', () => {
      expect(() => sm.transition('reconnecting')).toThrow('Invalid state transition');
    });

    it('should throw on connected → connecting', () => {
      sm.transition('connecting');
      sm.transition('connected');
      expect(() => sm.transition('connecting')).toThrow('Invalid state transition');
    });
  });

  describe('events', () => {
    it('should emit transition events', () => {
      const listener = vi.fn();
      sm.on('transition', listener);
      sm.transition('connecting');
      expect(listener).toHaveBeenCalledWith('disconnected', 'connecting');
    });

    it('should emit error on invalid transition', () => {
      const listener = vi.fn();
      sm.on('error', listener);
      try {
        sm.transition('connected');
      } catch {
        /* expected */
      }
      expect(listener).toHaveBeenCalled();
    });
  });

  describe('canTransition', () => {
    it('should return true for valid transitions', () => {
      expect(sm.canTransition('connecting')).toBe(true);
    });

    it('should return false for invalid transitions', () => {
      expect(sm.canTransition('connected')).toBe(false);
    });
  });

  describe('reset', () => {
    it('should reset to disconnected', () => {
      sm.transition('connecting');
      sm.transition('connected');
      sm.reset();
      expect(sm.state).toBe('disconnected');
    });

    it('should emit transition on reset', () => {
      const listener = vi.fn();
      sm.transition('connecting');
      sm.on('transition', listener);
      sm.reset();
      expect(listener).toHaveBeenCalledWith('connecting', 'disconnected');
    });

    it('should not emit if already disconnected', () => {
      const listener = vi.fn();
      sm.on('transition', listener);
      sm.reset();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('stateAge', () => {
    it('should report time in current state', async () => {
      sm.transition('connecting');
      await new Promise((r) => setTimeout(r, 50));
      expect(sm.stateAge).toBeGreaterThanOrEqual(40);
    });
  });
});
