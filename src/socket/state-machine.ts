import { EventEmitter } from 'node:events';
import type { ConnectionStatus } from '../types/socket.js';

/** Valid state transitions */
const TRANSITIONS: Record<ConnectionStatus, ConnectionStatus[]> = {
  disconnected: ['connecting'],
  connecting: ['connected', 'reconnecting', 'disconnected'],
  connected: ['reconnecting', 'disconnected'],
  reconnecting: ['connecting', 'disconnected'],
};

/** Events emitted by the connection state machine */
export interface StateMachineEvents {
  transition: (from: ConnectionStatus, to: ConnectionStatus) => void;
  error: (error: Error) => void;
}

/**
 * Connection state machine with strict transition validation.
 *
 * ```
 * DISCONNECTED ──connect()──→ CONNECTING
 * CONNECTING ──handshake ok──→ CONNECTED
 * CONNECTING ──error──→ RECONNECTING
 * CONNECTED ──disconnect──→ RECONNECTING
 * CONNECTED ──fatal──→ DISCONNECTED
 * RECONNECTING ──retry──→ CONNECTING
 * RECONNECTING ──exhausted──→ DISCONNECTED
 * ```
 */
export class ConnectionStateMachine extends EventEmitter {
  private _state: ConnectionStatus = 'disconnected';
  private _lastTransition = Date.now();

  /** Current connection state */
  get state(): ConnectionStatus {
    return this._state;
  }

  /** Timestamp of the last state transition */
  get lastTransitionAt(): number {
    return this._lastTransition;
  }

  /** Time spent in the current state (ms) */
  get stateAge(): number {
    return Date.now() - this._lastTransition;
  }

  /** Whether the socket is currently connected */
  get isConnected(): boolean {
    return this._state === 'connected';
  }

  /** Whether the socket is trying to connect */
  get isConnecting(): boolean {
    return this._state === 'connecting' || this._state === 'reconnecting';
  }

  /**
   * Transition to a new state.
   * Throws if the transition is not valid from the current state.
   */
  transition(to: ConnectionStatus): void {
    const from = this._state;
    const allowed = TRANSITIONS[from];

    if (!allowed.includes(to)) {
      const error = new Error(
        `Invalid state transition: ${from} → ${to} (allowed: ${allowed.join(', ')})`,
      );
      this.emit('error', error);
      throw error;
    }

    this._state = to;
    this._lastTransition = Date.now();
    this.emit('transition', from, to);
  }

  /** Check if a transition to the given state is valid */
  canTransition(to: ConnectionStatus): boolean {
    return TRANSITIONS[this._state].includes(to);
  }

  /** Reset to disconnected state (no validation) */
  reset(): void {
    const from = this._state;
    this._state = 'disconnected';
    this._lastTransition = Date.now();
    if (from !== 'disconnected') {
      this.emit('transition', from, 'disconnected');
    }
  }
}
