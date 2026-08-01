import { LicenseValidator } from "./license-validator";
// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1661@gmail.com

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
    LicenseValidator.validate(options as any);
    super();

    // Previously `new SyncForge()` and `new SyncForge(null)` failed with an
    // opaque "Cannot read properties of undefined (reading 'dbName')", while
    // `new SyncForge('name')`, `new SyncForge(42)` and `new SyncForge({})` were
    // accepted silently with `dbName === undefined`.
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError("SyncForge: options must be an object, e.g. new SyncForge({ dbName: 'my-app' })");
    }
    if (typeof options.dbName !== 'string' || options.dbName.length === 0) {
      throw new TypeError('SyncForge: options.dbName is required and must be a non-empty string');
    }
    if (options.peerId !== undefined && (typeof options.peerId !== 'string' || options.peerId.length === 0)) {
      throw new TypeError('SyncForge: options.peerId must be a non-empty string when provided');
    }

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
    // Forward connection diagnostics so callers can distinguish "peer left"
    // from "peer unreachable" from "signaling never came up".
    this.syncManager.on('connecting', (info: any) => this.emit('connecting', info));
    this.syncManager.on('peer-connected', (id: any) => this.emit('peer-connected', id));
    this.syncManager.on('peer-disconnected', (id: any) => this.emit('peer-disconnected', id));
    this.syncManager.on('peer-unreachable', (info: any) => this.emit('peer-unreachable', info));
    this.syncManager.on('ice-state', (info: any) => this.emit('ice-state', info));
    this.syncManager.on('ice-candidate-error', (info: any) => this.emit('ice-candidate-error', info));
    this.syncManager.on('signaling-failed', (info: any) => this.emit('signaling-failed', info));
    this.syncManager.on('error', (err: any) => this.emit('error', err));
  }

  /** True only when at least one peer data channel is open. */
  isOnline(): boolean {
    return this.syncManager.isConnected();
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

  /**
   * Replay an operation log produced by `exportData()`.
   *
   * Operations already applied are skipped by operation id, so importing the
   * same snapshot twice is now a no-op. Previously every `inc`/`dec` in the
   * snapshot was applied again, so `importData(await exportData())` silently
   * doubled every counter in the database.
   */
  async importData(json: string): Promise<void> {
    let ops: unknown;
    try {
      ops = JSON.parse(json);
    } catch (e) {
      throw new SyntaxError('SyncForge: importData received invalid JSON: ' +
        (e instanceof Error ? e.message : String(e)));
    }
    if (!Array.isArray(ops)) {
      throw new TypeError('SyncForge: importData expects a JSON array of operations');
    }
    for (const op of ops) {
      this.syncManager.receive(op as any);
    }
  }
}
