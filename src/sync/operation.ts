// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1661@gmail.com

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
