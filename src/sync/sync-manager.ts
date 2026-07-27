// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1661@gmail.com | +91 7031648617

import { EventEmitter } from '../events';
import { Operation } from './operation';
import { VectorClock } from './vector-clock';
import { WebRTCTransport } from './webrtc-transport';

export class SyncManager extends EventEmitter {
  private peerId: string;
  private vectorClock: VectorClock;
  private connected: boolean = false;
  private transport: WebRTCTransport;

  constructor(peerId: string) {
    super();
    this.peerId = peerId;
    this.vectorClock = new VectorClock(peerId);
    this.transport = new WebRTCTransport(peerId);

    this.transport.onMessage((data) => {
      this.handleRemoteData(data);
    });
  }

  connect(signalingUrl: string, roomId: string = 'default-room'): void {
    this.transport.connect(signalingUrl, roomId);
    this.connected = true;
    this.emit('online');
  }

  disconnect(): void {
    this.transport.disconnect();
    this.connected = false;
    this.emit('offline');
  }

  broadcast(operation: Operation): void {
    if (!this.connected) return;
    
    const encoder = new TextEncoder();
    
    const clockBytes = encoder.encode(JSON.stringify(this.vectorClock.getClock()));
    const typeBytes = encoder.encode(operation.type);
    const collectionBytes = encoder.encode(operation.collection);
    const docIdBytes = encoder.encode(operation.docId);
    const dataBytes = encoder.encode(JSON.stringify(operation));

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
    
    this.transport.send(buffer);
  }

  private handleRemoteData(data: ArrayBuffer | string): void {
    if (typeof data === 'string') return;
    
    const view = new DataView(data);
    let offset = 0;
    const decoder = new TextDecoder();
    
    const clockLen = view.getUint16(offset); offset += 2;
    const clockStr = decoder.decode(new Uint8Array(data, offset, clockLen)); offset += clockLen;
    
    const typeLen = view.getUint8(offset); offset += 1;
    // const typeStr = decoder.decode(new Uint8Array(data, offset, typeLen)); 
    offset += typeLen;
    
    const collectionLen = view.getUint16(offset); offset += 2;
    // const collectionStr = decoder.decode(new Uint8Array(data, offset, collectionLen)); 
    offset += collectionLen;
    
    const docIdLen = view.getUint16(offset); offset += 2;
    // const docIdStr = decoder.decode(new Uint8Array(data, offset, docIdLen)); 
    offset += docIdLen;
    
    const dataLen = view.getUint32(offset); offset += 4;
    const dataStr = decoder.decode(new Uint8Array(data, offset, dataLen)); offset += dataLen;
    
    try {
      const clock = JSON.parse(clockStr);
      const operation = JSON.parse(dataStr);
      
      this.vectorClock.update(clock);
      this.receive(operation);
    } catch (e) {
      console.error('Failed to parse remote operation', e);
    }
  }

  onRemoteOperation(callback: (op: Operation) => void): void {
    this.on('sync', callback);
  }

  receive(operation: Operation): void {
    this.vectorClock.update({ [operation.peerId]: operation.timestamp });
    this.emit('sync', operation);
  }

  getVectorClock(): VectorClock {
    return this.vectorClock;
  }
}
