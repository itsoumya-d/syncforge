import { EventEmitter } from '../events';
import { Operation } from './operation';
import { VectorClock } from './vector-clock';

export class SyncManager extends EventEmitter {
  private peerId: string;
  private vectorClock: VectorClock;
  private connected: boolean = false;
  // A naive mock of WebRTC data channel connections
  private peers: Set<string> = new Set();

  constructor(peerId: string) {
    super();
    this.peerId = peerId;
    this.vectorClock = new VectorClock(peerId);
  }

  connect(signalingUrl: string): void {
    // In a real implementation, connect via WebRTC using signaling server
    this.connected = true;
    this.emit('online');
  }

  disconnect(): void {
    this.connected = false;
    this.peers.clear();
    this.emit('offline');
  }

  broadcast(operation: Operation): void {
    if (!this.connected) return;
    // Broadcast operation to connected peers
    // (mock implementation)
  }

  receive(operation: Operation): void {
    this.vectorClock.update({ [operation.peerId]: operation.timestamp });
    this.emit('sync', operation);
  }

  getVectorClock(): VectorClock {
    return this.vectorClock;
  }
}
