import { MemoryAuthStore } from '../../src/store/memory.js';

/** Create a fresh in-memory store for testing */
export function createTestStore(): MemoryAuthStore {
  return new MemoryAuthStore();
}
