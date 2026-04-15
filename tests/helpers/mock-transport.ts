import { EventEmitter } from 'node:events';

/**
 * Mock WebSocket transport for offline testing.
 * Simulates the WhatsApp WebSocket connection without any network calls.
 */
export class MockTransport extends EventEmitter {
  private _connected = false;
  private _messages: unknown[] = [];

  get isConnected(): boolean {
    return this._connected;
  }

  get sentMessages(): readonly unknown[] {
    return this._messages;
  }

  async connect(): Promise<void> {
    this._connected = true;
    this.emit('open');
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    this.emit('close', { code: 1000, reason: 'normal' });
  }

  send(data: unknown): void {
    if (!this._connected) throw new Error('Not connected');
    this._messages.push(data);
  }

  /** Simulate receiving data from the server */
  simulateReceive(data: unknown): void {
    this.emit('message', data);
  }

  /** Simulate a disconnect with a specific code */
  simulateDisconnect(code: number, reason: string): void {
    this._connected = false;
    this.emit('close', { code, reason });
  }

  /** Simulate an error */
  simulateError(error: Error): void {
    this.emit('error', error);
  }

  /** Reset state */
  reset(): void {
    this._connected = false;
    this._messages = [];
    this.removeAllListeners();
  }
}
