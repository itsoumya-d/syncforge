// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1661@gmail.com

import { StorageAdapter } from './types';
import { Operation } from '../sync/operation';

export class MemoryAdapter implements StorageAdapter {
  /**
   * Map-backed store.
   *
   * This used to be a plain object indexed by the collection name, so a
   * collection called `__proto__` resolved `this.collections['__proto__']` to
   * `Object.prototype` (truthy, so the initialiser was skipped) and the next
   * line wrote a document straight onto `Object.prototype` — process-wide
   * prototype pollution. A document id of `__proto__` likewise reassigned the
   * collection object's prototype. `Map` keys cannot collide with prototype
   * members, which closes both vectors.
   */
  private collections: Map<string, Map<string, any>> = new Map();
  private operations: Operation[] = [];

  async get(collection: string, id: string): Promise<any> {
    const store = this.collections.get(collection);
    if (!store) return null;
    const value = store.get(id);
    return value === undefined ? null : value;
  }

  async set(collection: string, id: string, data: any): Promise<void> {
    let store = this.collections.get(collection);
    if (!store) {
      store = new Map();
      this.collections.set(collection, store);
    }
    store.set(id, data);
  }

  async delete(collection: string, id: string): Promise<void> {
    this.collections.get(collection)?.delete(id);
  }

  async getAll(collection: string): Promise<any[]> {
    const store = this.collections.get(collection);
    if (!store) return [];
    return Array.from(store.values());
  }

  async saveOperation(op: Operation): Promise<void> {
    this.operations.push(op);
  }

  async getOperations(): Promise<Operation[]> {
    return [...this.operations];
  }
}
