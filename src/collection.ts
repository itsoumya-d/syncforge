// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1619@gmail.com

import { Document } from './types';
import { Query } from './query';
import { EventEmitter } from './events';
import { SyncForge } from './syncforge';
import { StorageAdapter } from './storage/types';
import { SyncManager } from './sync/sync-manager';
import { LWWMap } from './crdt/lww-map';
import { PNCounter } from './crdt/pn-counter';

export class Collection extends EventEmitter {
  private name: string;
  private db: SyncForge;
  private storage: StorageAdapter;
  private sync: SyncManager;
  /**
   * Per-document serialisation chain.
   *
   * `applyOperationLocally` is a read-modify-write over the stored `_meta`
   * record. Without serialisation two overlapping operations on the same
   * document both read the same pre-state and the second write clobbers the
   * first, so e.g. `Promise.all([col.increment(...) x10])` produced 1 instead
   * of 10. Operations on the same document are now queued; operations on
   * different documents still run concurrently.
   */
  private applyQueues: Map<string, Promise<void>> = new Map();

  constructor(name: string, db: SyncForge, storage: StorageAdapter, sync: SyncManager) {
    super();
    this.name = name;
    this.db = db;
    this.storage = storage;
    this.sync = sync;

    this.sync.on('sync', (op: any) => {
      if (op.collection === this.name) {
        // Fire-and-forget by design (EventEmitter is synchronous), but errors
        // must not become unhandled rejections.
        this.applyOperationLocally(op).catch((err) => {
          console.error('SyncForge: failed to apply remote operation', err);
        });
      }
    });
  }

  async set(id: string, data: object): Promise<void> {
    // A value containing a cycle (or a BigInt) cannot be broadcast or exported.
    // Previously such a value was applied and persisted, then JSON.stringify
    // threw: `broadcast()` rejected the already-committed set(), and
    // `exportData()` stayed permanently broken because the poisoned operation
    // could not be removed. Fail fast instead, before mutating any state.
    Collection.assertSerialisable(data);
    const timestamp = this.sync.getVectorClock().increment();
    const op = {
      id: `${this.db.peerId}-${timestamp}`,
      type: 'set' as const,
      collection: this.name,
      docId: id,
      field: '',
      value: data,
      timestamp,
      peerId: this.db.peerId
    };
    
    this.sync.markApplied(op.id);
    await this.applyOperationLocally(op);
    await this.storage.saveOperation(op);
    this.sync.broadcast(op);
  }

  async get(id: string): Promise<Document | null> {
    return this.storage.get(this.name, id);
  }

  async delete(id: string): Promise<void> {
    const timestamp = this.sync.getVectorClock().increment();
    const op = {
      id: `${this.db.peerId}-${timestamp}`,
      type: 'delete' as const,
      collection: this.name,
      docId: id,
      field: '',
      value: null,
      timestamp,
      peerId: this.db.peerId
    };
    
    this.sync.markApplied(op.id);
    await this.applyOperationLocally(op);
    await this.storage.saveOperation(op);
    this.sync.broadcast(op);
  }

  async getAll(): Promise<Document[]> {
    return this.storage.getAll(this.name);
  }

  where(field: string, op: '==' | '!=' | '>' | '<' | '>=' | '<=', value: any): Query {
    return new Query(this).where(field, op, value);
  }

  orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): Query {
    return new Query(this).orderBy(field, direction);
  }

  limit(n: number): Query {
    return new Query(this).limit(n);
  }

  subscribe(callback: (docs: Document[]) => void): () => void {
    const listener = async () => {
      const docs = await this.getAll();
      callback(docs);
    };
    this.on('change', listener);
    listener(); // Initial call
    return () => this.off('change', listener);
  }

  subscribeDoc(id: string, callback: (doc: Document | null) => void): () => void {
    const listener = async (changedId?: string) => {
      if (!changedId || changedId === id) {
        const doc = await this.get(id);
        callback(doc);
      }
    };
    this.on('change', listener);
    listener(); // Initial call
    return () => this.off('change', listener);
  }

  async increment(id: string, field: string, amount: number = 1): Promise<void> {
    const timestamp = this.sync.getVectorClock().increment();
    const op = {
      id: `${this.db.peerId}-${timestamp}`,
      type: 'inc' as const,
      collection: this.name,
      docId: id,
      field,
      value: amount,
      timestamp,
      peerId: this.db.peerId
    };
    
    this.sync.markApplied(op.id);
    await this.applyOperationLocally(op);
    await this.storage.saveOperation(op);
    this.sync.broadcast(op);
  }

  async decrement(id: string, field: string, amount: number = 1): Promise<void> {
    const timestamp = this.sync.getVectorClock().increment();
    const op = {
      id: `${this.db.peerId}-${timestamp}`,
      type: 'dec' as const,
      collection: this.name,
      docId: id,
      field,
      value: amount,
      timestamp,
      peerId: this.db.peerId
    };
    
    this.sync.markApplied(op.id);
    await this.applyOperationLocally(op);
    await this.storage.saveOperation(op);
    this.sync.broadcast(op);
  }

  /**
   * Queue `op` behind any in-flight operation for the same document, so the
   * read-modify-write below can never interleave with itself.
   */
  private applyOperationLocally(op: any): Promise<void> {
    const key = String(op && op.docId);
    const previous = this.applyQueues.get(key) || Promise.resolve();
    const next = previous
      .catch(() => { /* a failed predecessor must not block the queue */ })
      .then(() => this.applyOperationUnsafe(op));
    this.applyQueues.set(key, next);
    // Drop the chain once it drains so the map does not grow without bound.
    next.catch(() => {}).then(() => {
      if (this.applyQueues.get(key) === next) this.applyQueues.delete(key);
    });
    return next;
  }

  private static assertSerialisable(data: unknown): void {
    try {
      JSON.stringify(data);
    } catch (err) {
      throw new TypeError(
        'SyncForge: document value is not JSON-serialisable (circular reference or BigInt). ' +
        'Nothing was written. Original error: ' + (err instanceof Error ? err.message.split('\n')[0] : String(err))
      );
    }
  }

  private async applyOperationUnsafe(op: any): Promise<void> {
    const meta = await this.storage.get(`${this.name}_meta`, op.docId) || { mapData: {}, counterData: {} };

    const map = new LWWMap();
    if (meta.mapData) {
      for (const [k, v] of Object.entries(meta.mapData)) {
        map.set(k, (v as any).value, (v as any).timestamp, (v as any).peerId);
      }
    }

    const counters: Record<string, PNCounter> = {};
    if (meta.counterData) {
      for (const [k, v] of Object.entries(meta.counterData)) {
        counters[k] = new PNCounter((v as any).positives, (v as any).negatives);
      }
    }

    if (op.type === 'set') {
      for (const [k, v] of Object.entries(op.value || {})) {
        map.set(k, v, op.timestamp, op.peerId);
      }
      // Clear any tombstone. `_deleted` is an ordinary LWW register, so a set
      // that happens-after a delete resurrects the document and a set that
      // happens-before it correctly loses. Previously `_deleted` was only ever
      // set to true, which made deletion permanent: a later set() resolved
      // successfully but get() returned null forever.
      map.set('_deleted', false, op.timestamp, op.peerId);
    } else if (op.type === 'delete') {
      map.set('_deleted', true, op.timestamp, op.peerId);
    } else if (op.type === 'inc') {
      if (!counters[op.field]) counters[op.field] = new PNCounter();
      counters[op.field].increment(op.peerId, op.value);
    } else if (op.type === 'dec') {
      if (!counters[op.field]) counters[op.field] = new PNCounter();
      counters[op.field].decrement(op.peerId, op.value);
    }

    meta.mapData = {};
    for (const [k, reg] of map.data.entries()) {
      meta.mapData[k] = { value: reg.value, timestamp: reg.timestamp, peerId: reg.peerId };
    }
    
    meta.counterData = {};
    for (const [k, counter] of Object.entries(counters)) {
      meta.counterData[k] = { positives: counter.positives.counts, negatives: counter.negatives.counts };
    }
    await this.storage.set(`${this.name}_meta`, op.docId, meta);

    const docView = map.toJSON();
    for (const [k, counter] of Object.entries(counters)) {
      docView[k] = (docView[k] || 0) + counter.value;
    }

    // `_deleted` is internal bookkeeping and must not leak into user documents.
    const isDeleted = docView._deleted === true;
    delete docView._deleted;

    if (isDeleted) {
      await this.storage.delete(this.name, op.docId);
    } else {
      await this.storage.set(this.name, op.docId, docView);
    }

    this.emit('change', op.docId);
    this.db.emit('change', { collection: this.name, docId: op.docId });
  }
}
