import { Operation } from '../sync/operation';

export interface StorageAdapter {
  get(collection: string, id: string): Promise<any>;
  set(collection: string, id: string, data: any): Promise<void>;
  delete(collection: string, id: string): Promise<void>;
  getAll(collection: string): Promise<any[]>;
  saveOperation(op: Operation): Promise<void>;
  getOperations(): Promise<Operation[]>;
}
