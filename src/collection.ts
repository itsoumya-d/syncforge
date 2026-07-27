// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1661@gmail.com | +91 7031648617

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

  constructor(name: string, db: SyncForge, storage: StorageAdapter, sync: SyncManager) {
    super();
    this.name = name;
    this.db = db;
    this.storage = storage;
    this.sync = sync;

    this.sync.on('sync', async (op: any) => {
      if (op.collection === this.name) {
        await this.applyOperationLocally(op);
      }
    });
  }

  async set(id: string, data: object): Promise<void> {
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
    
    await this.applyOperationLocally(op);
    await this.storage.saveOperation(op);
    this.sync.broadcast(op);
  }

  private async applyOperationLocally(op: any): Promise<void> {
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

    if (docView._deleted) {
      await this.storage.delete(this.name, op.docId);
    } else {
      await this.storage.set(this.name, op.docId, docView);
    }

    this.emit('change', op.docId);
    this.db.emit('change', { collection: this.name, docId: op.docId });
  }
}
