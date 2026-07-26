import { StorageAdapter } from './types';
import { Operation } from '../sync/operation';

export class MemoryAdapter implements StorageAdapter {
  private collections: Record<string, Record<string, any>> = {};
  private operations: Operation[] = [];

  async get(collection: string, id: string): Promise<any> {
    return this.collections[collection]?.[id] || null;
  }

  async set(collection: string, id: string, data: any): Promise<void> {
    if (!this.collections[collection]) {
      this.collections[collection] = {};
    }
    this.collections[collection][id] = data;
  }

  async delete(collection: string, id: string): Promise<void> {
    if (this.collections[collection]) {
      delete this.collections[collection][id];
    }
  }

  async getAll(collection: string): Promise<any[]> {
    if (!this.collections[collection]) return [];
    return Object.values(this.collections[collection]);
  }

  async saveOperation(op: Operation): Promise<void> {
    this.operations.push(op);
  }

  async getOperations(): Promise<Operation[]> {
    return [...this.operations];
  }
}
