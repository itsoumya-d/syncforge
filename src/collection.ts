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
    const doc = await this.storage.get(this.name, op.docId) || {};
    
    if (op.type === 'set') {
      Object.assign(doc, op.value);
      await this.storage.set(this.name, op.docId, doc);
    } else if (op.type === 'delete') {
      await this.storage.delete(this.name, op.docId);
    } else if (op.type === 'inc') {
      doc[op.field] = (doc[op.field] || 0) + op.value;
      await this.storage.set(this.name, op.docId, doc);
    } else if (op.type === 'dec') {
      doc[op.field] = (doc[op.field] || 0) - op.value;
      await this.storage.set(this.name, op.docId, doc);
    }

    this.emit('change', op.docId);
    this.db.emit('change', { collection: this.name, docId: op.docId });
  }
}
