// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1619@gmail.com

export type OperationType = 'set' | 'delete' | 'inc' | 'dec' | 'add' | 'remove';

export interface Operation {
  id: string; // Operation ID (usually peerId-timestamp)
  type: OperationType;
  collection: string;
  docId: string;
  field: string;
  value: any;
  timestamp: number; // Lamport timestamp
  peerId: string;
}

/** Validate snapshot/wire operation records before applying them. */
export function assertOperation(value: unknown): asserts value is Operation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('SyncForge: invalid operation record');
  }
  const op = value as Operation;
  if (typeof op.id !== 'string' || op.id.length === 0 ||
      typeof op.collection !== 'string' || typeof op.docId !== 'string' ||
      typeof op.field !== 'string' || typeof op.peerId !== 'string' || op.peerId.length === 0 ||
      !Number.isSafeInteger(op.timestamp) || op.timestamp < 0 ||
      !['set', 'delete', 'inc', 'dec'].includes(op.type)) {
    throw new TypeError('SyncForge: invalid operation identity, timestamp or type');
  }
  if (op.type === 'set' && op.value !== null && typeof op.value !== 'object') {
    throw new TypeError('SyncForge: set operation requires an object or null');
  }
  if ((op.type === 'inc' || op.type === 'dec') &&
      (typeof op.value !== 'number' || !Number.isFinite(op.value) || op.value < 0 ||
       ['__proto__', 'constructor', 'prototype'].includes(op.field))) {
    throw new TypeError('SyncForge: invalid counter operation');
  }
}
