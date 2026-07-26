// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1661@gmail.com | +91 7031648617

import { SyncForgeOptions } from './types';
import { Collection } from './collection';
import { SyncManager } from './sync/sync-manager';
import { StorageAdapter } from './storage/types';
import { IndexedDBAdapter } from './storage/indexeddb-adapter';
import { EventEmitter } from './events';
import { MemoryAdapter } from './storage/memory-adapter';

export class SyncForge extends EventEmitter {
  public peerId: string;
  private dbName: string;
  private collections: Map<string, Collection> = new Map();
  private syncManager: SyncManager;
  private storage: StorageAdapter;

  constructor(options: SyncForgeOptions) {
    super();
    this.dbName = options.dbName;
    // Generate a random peerId if not provided
    this.peerId = options.peerId || Math.random().toString(36).substring(2, 9);
    
    // Choose storage adapter based on environment
    if (typeof indexedDB !== 'undefined') {
      this.storage = new IndexedDBAdapter(this.dbName);
    } else {
      this.storage = new MemoryAdapter();
    }

    this.syncManager = new SyncManager(this.peerId);
    
    this.syncManager.on('online', () => this.emit('online'));
    this.syncManager.on('offline', () => this.emit('offline'));
    this.syncManager.on('sync', (op: any) => this.emit('sync', op));
  }

  collection(name: string): Collection {
    if (!this.collections.has(name)) {
      this.collections.set(name, new Collection(name, this, this.storage, this.syncManager));
    }
    return this.collections.get(name)!;
  }

  connectPeer(signalingUrl: string): void {
    this.syncManager.connect(signalingUrl);
  }

  disconnect(): void {
    this.syncManager.disconnect();
  }

  async exportData(): Promise<string> {
    const ops = await this.storage.getOperations();
    return JSON.stringify(ops);
  }

  async importData(json: string): Promise<void> {
    try {
      const ops = JSON.parse(json);
      if (Array.isArray(ops)) {
        for (const op of ops) {
          // Simply push operation through the sync manager to process
          this.syncManager.receive(op);
        }
      }
    } catch (e) {
      console.error('Failed to import data:', e);
    }
  }
}
