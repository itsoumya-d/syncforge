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
