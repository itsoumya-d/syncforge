// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1661@gmail.com | +91 7031648617

import { Document } from './types';
import type { Collection } from './collection';

export class Query {
  private _where: { field: string, op: string, value: any }[] = [];
  private _orderBy?: { field: string, direction: 'asc' | 'desc' };
  private _limit?: number;
  private collection: Collection;

  constructor(collection: Collection) {
    this.collection = collection;
  }

  where(field: string, op: '==' | '!=' | '>' | '<' | '>=' | '<=', value: any): Query {
    this._where.push({ field, op, value });
    return this;
  }

  orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): Query {
    this._orderBy = { field, direction };
    return this;
  }

  limit(n: number): Query {
    this._limit = n;
    return this;
  }

  execute(docs: Document[]): Document[] {
    let result = [...docs];

    // Apply where
    for (const condition of this._where) {
      result = result.filter((doc) => {
        const docVal = doc[condition.field];
        switch (condition.op) {
          case '==': return docVal === condition.value;
          case '!=': return docVal !== condition.value;
          case '>': return docVal > condition.value;
          case '<': return docVal < condition.value;
          case '>=': return docVal >= condition.value;
          case '<=': return docVal <= condition.value;
          default: return false;
        }
      });
    }

    // Apply orderBy
    if (this._orderBy) {
      const { field, direction } = this._orderBy;
      result.sort((a, b) => {
        if (a[field] < b[field]) return direction === 'asc' ? -1 : 1;
        if (a[field] > b[field]) return direction === 'asc' ? 1 : -1;
        return 0;
      });
    }

    // Apply limit
    if (this._limit !== undefined) {
      result = result.slice(0, this._limit);
    }

    return result;
  }

  async get(): Promise<Document[]> {
    const docs = await this.collection.getAll();
    return this.execute(docs);
  }

  subscribe(callback: (docs: Document[]) => void): () => void {
    return this.collection.subscribe((docs) => {
      callback(this.execute(docs));
    });
  }
}
