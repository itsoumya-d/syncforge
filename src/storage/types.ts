// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1661@gmail.com

import { Operation } from '../sync/operation';

export interface StorageAdapter {
  get(collection: string, id: string): Promise<any>;
  set(collection: string, id: string, data: any): Promise<void>;
  delete(collection: string, id: string): Promise<void>;
  getAll(collection: string): Promise<any[]>;
  saveOperation(op: Operation): Promise<void>;
  getOperations(): Promise<Operation[]>;
}
