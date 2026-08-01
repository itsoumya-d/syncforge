// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1619@gmail.com

import { StorageAdapter } from './types';
import { Operation } from '../sync/operation';

export class IndexedDBAdapter implements StorageAdapter {
  private dbName: string;
  private db: IDBDatabase | null = null;
  private ready: Promise<void>;

  constructor(dbName: string) {
    this.dbName = dbName;
    this.ready = this.init();
  }

  private init(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Stub check for non-browser environments
      if (typeof indexedDB === 'undefined') {
        resolve(); // We won't use it anyway if running in node without polyfill
        return;
      }
      
      const request = indexedDB.open(this.dbName, 1);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('documents')) {
          db.createObjectStore('documents', { keyPath: ['collection', 'id'] });
        }
        if (!db.objectStoreNames.contains('operations')) {
          db.createObjectStore('operations', { keyPath: 'id' });
        }
      };

      request.onsuccess = (event) => {
        this.db = (event.target as IDBOpenDBRequest).result;
        resolve();
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  async get(collection: string, id: string): Promise<any> {
    await this.ready;
    if (!this.db) return null;
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction('documents', 'readonly');
      const store = transaction.objectStore('documents');
      const request = store.get([collection, id]);
      
      request.onsuccess = () => resolve(request.result?.data || null);
      request.onerror = () => reject(request.error);
    });
  }

  async set(collection: string, id: string, data: any): Promise<void> {
    await this.ready;
    if (!this.db) return;
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction('documents', 'readwrite');
      const store = transaction.objectStore('documents');
      const request = store.put({ collection, id, data });
      
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async delete(collection: string, id: string): Promise<void> {
    await this.ready;
    if (!this.db) return;
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction('documents', 'readwrite');
      const store = transaction.objectStore('documents');
      const request = store.delete([collection, id]);
      
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getAll(collection: string): Promise<any[]> {
    await this.ready;
    if (!this.db) return [];
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction('documents', 'readonly');
      const store = transaction.objectStore('documents');
      const request = store.getAll();
      
      request.onsuccess = () => {
        const results = request.result.filter((item: any) => item.collection === collection).map((item: any) => item.data);
        resolve(results);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async saveOperation(op: Operation): Promise<void> {
    await this.ready;
    if (!this.db) return;
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction('operations', 'readwrite');
      const store = transaction.objectStore('operations');
      const request = store.put(op);
      
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getOperations(): Promise<Operation[]> {
    await this.ready;
    if (!this.db) return [];
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction('operations', 'readonly');
      const store = transaction.objectStore('operations');
      const request = store.getAll();
      
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}
