// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1661@gmail.com

import { EventEmitter } from '../events';
import { Operation } from './operation';
import { VectorClock } from './vector-clock';
import { WebRTCTransport } from './webrtc-transport';

export class SyncManager extends EventEmitter {
  private peerId: string;
  private vectorClock: VectorClock;
  private connected: boolean = false;
  private transport: WebRTCTransport;

  /**
   * Operation ids already applied, for at-least-once delivery.
   *
   * `set`/`delete` are idempotent (last-writer-wins), but `inc`/`dec` are not:
   * re-applying an increment adds the amount again. Without dedup, duplicate
   * delivery (a retry, a resync, or `importData()` of a snapshot that overlaps
   * the local log) permanently diverged counters between replicas.
   *
   * Bounded FIFO so a long-lived session cannot grow it without limit.
   */
  private appliedOps: Set<string> = new Set();
  private appliedOrder: string[] = [];
  private static readonly MAX_APPLIED_OPS = 100000;

  constructor(peerId: string) {
    super();
    this.peerId = peerId;
    this.vectorClock = new VectorClock(peerId);
    this.transport = new WebRTCTransport(peerId);

    this.transport.onMessage((data) => {
      this.handleRemoteData(data);
    });

    // Surface transport state on the public event bus.
    //
    // Previously `WebRTCTransport` was neither exported nor reachable, so its
    // 'peer-connected' / 'peer-disconnected' events could not be observed by
    // any caller, and a signaling or ICE failure produced no signal at all.
    this.transport.on('peer-connected', (peerId: string) => {
      const wasConnected = this.connected;
      this.connected = true;
      this.emit('peer-connected', peerId);
      if (!wasConnected) this.emit('online');
    });

    this.transport.on('peer-disconnected', (peerId: string) => {
      this.emit('peer-disconnected', peerId);
      if (!this.transport.hasOpenChannel()) {
        if (this.connected) this.emit('offline');
        this.connected = false;
      }
    });

    this.transport.on('peer-unreachable', (info: any) => this.emit('peer-unreachable', info));
    this.transport.on('ice-state', (info: any) => this.emit('ice-state', info));
    this.transport.on('ice-candidate-error', (info: any) => this.emit('ice-candidate-error', info));
    this.transport.on('error', (err: any) => this.emit('error', err));

    this.transport.on('signaling-failed', (info: any) => {
      if (this.connected) this.emit('offline');
      this.connected = false;
      this.emit('signaling-failed', info);
      this.emit('error', (info && info.cause) || new Error('SyncForge: signaling unreachable'));
    });
  }

  /**
   * Begin connecting.
   *
   * This does NOT mean the peer is online. `connect()` used to set
   * `connected = true` and emit 'online' synchronously, before the signaling
   * socket had even opened — so the caller was told it was online even when the
   * host did not exist, and was never told otherwise. 'online' is now emitted
   * when the first peer data channel actually opens, and 'offline' when the
   * last one closes or signaling fails permanently.
   */
  connect(signalingUrl: string, roomId: string = 'default-room'): void {
    this.emit('connecting', { signalingUrl, roomId });
    this.transport.connect(signalingUrl, roomId);
  }

  /** True only when at least one peer data channel is open. */
  isConnected(): boolean {
    return this.connected;
  }

  disconnect(): void {
    this.transport.disconnect();
    this.connected = false;
    this.emit('offline');
  }

  /**
   * Encode and fan out an operation.
   *
   * Returns the number of peers it reached. 0 means the operation exists only
   * locally: there is no outbox, so it will NOT be retried or replayed when a
   * peer later connects. Callers that need guaranteed propagation must track
   * this themselves (see `exportData()` / `importData()`).
   */
  broadcast(operation: Operation): number {
    if (!this.connected) return 0;

    const encoder = new TextEncoder();
    
    let clockBytes: Uint8Array;
    let typeBytes: Uint8Array;
    let collectionBytes: Uint8Array;
    let docIdBytes: Uint8Array;
    let dataBytes: Uint8Array;
    try {
      clockBytes = encoder.encode(JSON.stringify(this.vectorClock.getClock()));
      typeBytes = encoder.encode(operation.type);
      collectionBytes = encoder.encode(operation.collection);
      docIdBytes = encoder.encode(operation.docId);
      dataBytes = encoder.encode(JSON.stringify(operation));
    } catch (e) {
      // A non-serialisable operation must not reject the caller's already
      // committed local write.
      console.error('SyncForge: operation could not be serialised for broadcast', e);
      return 0;
    }

    // The header stores these lengths in Uint16 fields. Anything longer wraps
    // and produces a frame that the receiver cannot parse (it previously threw
    // `RangeError: Invalid typed array length` on the other side). Refuse to
    // emit a corrupt frame instead.
    if (clockBytes.length > 0xffff || typeBytes.length > 0xff ||
        collectionBytes.length > 0xffff || docIdBytes.length > 0xffff) {
      console.error(
        'SyncForge: refusing to broadcast operation — a header field exceeds its wire limit ' +
        '(clock=' + clockBytes.length + '/65535, type=' + typeBytes.length + '/255, ' +
        'collection=' + collectionBytes.length + '/65535, docId=' + docIdBytes.length + '/65535). ' +
        'The write is stored locally but was not sent.'
      );
      return 0;
    }

    const buffer = new ArrayBuffer(2 + clockBytes.length + 1 + typeBytes.length + 2 + collectionBytes.length + 2 + docIdBytes.length + 4 + dataBytes.length);
    const view = new DataView(buffer);
    let offset = 0;
    
    view.setUint16(offset, clockBytes.length); offset += 2;
    new Uint8Array(buffer, offset, clockBytes.length).set(clockBytes); offset += clockBytes.length;
    
    view.setUint8(offset, typeBytes.length); offset += 1;
    new Uint8Array(buffer, offset, typeBytes.length).set(typeBytes); offset += typeBytes.length;
    
    view.setUint16(offset, collectionBytes.length); offset += 2;
    new Uint8Array(buffer, offset, collectionBytes.length).set(collectionBytes); offset += collectionBytes.length;
    
    view.setUint16(offset, docIdBytes.length); offset += 2;
    new Uint8Array(buffer, offset, docIdBytes.length).set(docIdBytes); offset += docIdBytes.length;
    
    view.setUint32(offset, dataBytes.length); offset += 4;
    new Uint8Array(buffer, offset, dataBytes.length).set(dataBytes); offset += dataBytes.length;

    return this.transport.send(buffer);
  }

  /**
   * Decode an inbound frame.
   *
   * Every length field is attacker-controlled: a peer only needs the room id to
   * send arbitrary bytes (there is no authentication). Previously the header
   * parse sat *outside* the try/catch, so a 1-byte frame threw
   * `RangeError: Offset is outside the bounds of the DataView` straight out of
   * the data-channel `onmessage` handler, and a frame declaring a huge length
   * threw `RangeError: Invalid typed array length`. Every read is now bounds
   * checked against the real buffer length and the whole body is guarded.
   */
  private handleRemoteData(data: ArrayBuffer | string): void {
    if (typeof data === 'string') return;
    if (!data || typeof (data as ArrayBuffer).byteLength !== 'number') return;

    try {
      const total = data.byteLength;
      const view = new DataView(data);
      let offset = 0;
      const decoder = new TextDecoder();

      // Fixed part of the header: 2 + 1 + 2 + 2 + 4 bytes of length fields.
      if (total < 11) {
        console.warn('SyncForge: dropping truncated frame', total, 'bytes');
        return;
      }

      const need = (n: number): boolean => {
        if (n < 0 || offset + n > total) {
          console.warn('SyncForge: dropping malformed frame (declared length exceeds payload)');
          return false;
        }
        return true;
      };

      const clockLen = view.getUint16(offset); offset += 2;
      if (!need(clockLen)) return;
      const clockStr = decoder.decode(new Uint8Array(data, offset, clockLen)); offset += clockLen;

      if (!need(1)) return;
      const typeLen = view.getUint8(offset); offset += 1;
      if (!need(typeLen)) return;
      offset += typeLen;

      if (!need(2)) return;
      const collectionLen = view.getUint16(offset); offset += 2;
      if (!need(collectionLen)) return;
      offset += collectionLen;

      if (!need(2)) return;
      const docIdLen = view.getUint16(offset); offset += 2;
      if (!need(docIdLen)) return;
      offset += docIdLen;

      if (!need(4)) return;
      const dataLen = view.getUint32(offset); offset += 4;
      if (!need(dataLen)) return;
      const dataStr = decoder.decode(new Uint8Array(data, offset, dataLen)); offset += dataLen;

      const clock = JSON.parse(clockStr);
      const operation = JSON.parse(dataStr);

      if (clock && typeof clock === 'object') this.vectorClock.update(clock);
      this.receive(operation);
    } catch (e) {
      console.error('SyncForge: failed to parse remote operation', e);
    }
  }

  onRemoteOperation(callback: (op: Operation) => void): void {
    this.on('sync', callback);
  }

  /**
   * Apply an operation received from a peer (or replayed from a snapshot).
   *
   * Duplicates are dropped by operation id so that at-least-once delivery is
   * safe for the non-idempotent `inc`/`dec` operations.
   */
  receive(operation: Operation): void {
    if (!operation || typeof operation !== 'object') return;

    const id = operation.id;
    if (typeof id === 'string' && id.length > 0) {
      if (this.appliedOps.has(id)) return;
      this.appliedOps.add(id);
      this.appliedOrder.push(id);
      if (this.appliedOrder.length > SyncManager.MAX_APPLIED_OPS) {
        const evicted = this.appliedOrder.shift();
        if (evicted !== undefined) this.appliedOps.delete(evicted);
      }
    }

    if (typeof operation.peerId === 'string' && typeof operation.timestamp === 'number') {
      this.vectorClock.update({ [operation.peerId]: operation.timestamp });
    }
    this.emit('sync', operation);
  }

  /** Record a locally generated operation id so an echo of it is ignored. */
  markApplied(operationId: string): void {
    if (typeof operationId !== 'string' || operationId.length === 0) return;
    if (this.appliedOps.has(operationId)) return;
    this.appliedOps.add(operationId);
    this.appliedOrder.push(operationId);
    if (this.appliedOrder.length > SyncManager.MAX_APPLIED_OPS) {
      const evicted = this.appliedOrder.shift();
      if (evicted !== undefined) this.appliedOps.delete(evicted);
    }
  }

  getVectorClock(): VectorClock {
    return this.vectorClock;
  }
}
