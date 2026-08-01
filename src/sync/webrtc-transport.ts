// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1619@gmail.com

import { EventEmitter } from '../events';

export class WebRTCTransport extends EventEmitter {
  private peers: Map<string, RTCPeerConnection> = new Map();
  private dataChannels: Map<string, RTCDataChannel> = new Map();
  private ws: WebSocket | null = null;
  private signalingUrl: string = '';
  private roomId: string = '';
  private peerId: string;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private messageHandler: ((data: ArrayBuffer | string) => void) | null = null;

  constructor(peerId: string) {
    super();
    this.peerId = peerId;
  }

  connect(signalingUrl: string, roomId: string): void {
    this.signalingUrl = signalingUrl;
    this.roomId = roomId;
    this.connectWebSocket();
  }

  private connectWebSocket() {
    if (typeof WebSocket === 'undefined') {
      this.emit('error', new Error('SyncForge: no WebSocket implementation available in this environment'));
      return;
    }
    try {
      this.ws = new WebSocket(this.signalingUrl);
    } catch (err) {
      // e.g. an invalid or non-ws: URL throws synchronously.
      this.emit('error', err);
      this.emit('signaling-failed', { url: this.signalingUrl, attempts: this.reconnectAttempts, cause: err });
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.emit('signaling-open', this.signalingUrl);
      this.ws?.send(JSON.stringify({ type: 'join', roomId: this.roomId, peerId: this.peerId }));
    };

    // Previously no onerror handler was installed at all, so a refused or
    // unresolvable signaling host produced no observable signal whatsoever.
    this.ws.onerror = (event: any) => {
      this.emit('error', new Error('SyncForge: signaling socket error for ' + this.signalingUrl));
      void event;
    };

    this.ws.onmessage = async (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { console.warn('SyncForge: Malformed WS message'); return; }
      try {
        if (message.type === 'peer-joined') {
          await this.handlePeerJoined(message.peerId);
        } else if (message.type === 'offer') {
          await this.handleOffer(message.peerId, message.offer);
        } else if (message.type === 'answer') {
          await this.handleAnswer(message.peerId, message.answer);
        } else if (message.type === 'ice-candidate') {
          await this.handleIceCandidate(message.peerId, message.candidate);
        } else if (message.type === 'peer-left') {
          this.handlePeerLeft(message.peerId);
        }
      } catch (err) {
        console.warn('SyncForge: Error handling signaling message', err);
      }
    };

    this.ws.onclose = () => {
      this.emit('signaling-closed', this.signalingUrl);
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        const backoff = Math.pow(2, this.reconnectAttempts) * 1000;
        this.reconnectAttempts++;
        setTimeout(() => this.connectWebSocket(), backoff);
      } else {
        // The reconnect budget (5 attempts, ~31 s) is exhausted. Previously the
        // transport gave up silently and the caller was left believing it was
        // still online forever.
        this.emit('signaling-failed', {
          url: this.signalingUrl,
          attempts: this.reconnectAttempts,
          cause: new Error('SyncForge: signaling unreachable after ' + this.reconnectAttempts + ' attempts')
        });
      }
    };
  }

  private async handlePeerJoined(remotePeerId: string) {
    const pc = this.createPeerConnection(remotePeerId);
    const dc = this.createDataChannelForPeer(pc, 'sync');
    this.setupDataChannel(remotePeerId, dc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    this.ws?.send(JSON.stringify({
      type: 'offer',
      target: remotePeerId,
      peerId: this.peerId,
      offer
    }));
  }

  private async handleOffer(remotePeerId: string, offer: RTCSessionDescriptionInit) {
    // Close existing connection if present (prevents orphaned PeerConnections / memory leak)
    const existingPc = this.peers.get(remotePeerId);
    if (existingPc) {
      try { existingPc.close(); } catch {}
      this.peers.delete(remotePeerId);
    }
    const pc = this.createPeerConnection(remotePeerId);
    
    pc.ondatachannel = (event) => {
      this.setupDataChannel(remotePeerId, event.channel);
    };

    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    this.ws?.send(JSON.stringify({
      type: 'answer',
      target: remotePeerId,
      peerId: this.peerId,
      answer
    }));
  }

  private async handleAnswer(remotePeerId: string, answer: RTCSessionDescriptionInit) {
    const pc = this.peers.get(remotePeerId);
    if (pc) {
      await pc.setRemoteDescription(answer);
    }
  }

  private async handleIceCandidate(remotePeerId: string, candidate: RTCIceCandidateInit) {
    const pc = this.peers.get(remotePeerId);
    if (pc) {
      await pc.addIceCandidate(candidate);
    }
  }

  private handlePeerLeft(remotePeerId: string) {
    const pc = this.peers.get(remotePeerId);
    if (pc) {
      pc.close();
      this.peers.delete(remotePeerId);
    }
    this.dataChannels.delete(remotePeerId);
  }

  private createPeerConnection(remotePeerId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    // Surface ICE failure. Without a TURN relay, symmetric and carrier-grade
    // NAT will reach 'failed' and no data channel will ever open; previously
    // that produced no event at any layer.
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      this.emit('ice-state', { peerId: remotePeerId, state });
      if (state === 'failed') {
        this.emit('peer-unreachable', {
          peerId: remotePeerId,
          reason: 'ice-failed',
          hint: 'No TURN relay is configured; symmetric/CGNAT peers cannot be reached over STUN alone.'
        });
        this.dataChannels.delete(remotePeerId);
        this.emit('peer-disconnected', remotePeerId);
      } else if (state === 'disconnected') {
        this.emit('peer-unreachable', { peerId: remotePeerId, reason: 'ice-disconnected' });
      }
    };

    pc.onicecandidateerror = (event: any) => {
      this.emit('ice-candidate-error', {
        peerId: remotePeerId,
        errorCode: event && event.errorCode,
        errorText: event && event.errorText,
        url: event && event.url
      });
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.ws?.send(JSON.stringify({
          type: 'ice-candidate',
          target: remotePeerId,
          peerId: this.peerId,
          candidate: event.candidate
        }));
      }
    };

    this.peers.set(remotePeerId, pc);
    return pc;
  }

  createDataChannelForPeer(pc: RTCPeerConnection, label: string): RTCDataChannel {
    return pc.createDataChannel(label);
  }



  private setupDataChannel(remotePeerId: string, dc: RTCDataChannel) {
    dc.binaryType = 'arraybuffer';
    
    dc.onopen = () => {
      this.dataChannels.set(remotePeerId, dc);
      this.emit('peer-connected', remotePeerId);
    };

    dc.onclose = () => {
      this.dataChannels.delete(remotePeerId);
      this.emit('peer-disconnected', remotePeerId);
    };

    dc.onmessage = (event) => {
      if (!this.messageHandler) return;
      // A malformed frame from a peer must not escape as an uncaught exception
      // in the event handler.
      try {
        this.messageHandler(event.data);
      } catch (err) {
        console.error('SyncForge: error handling peer message', err);
      }
    };
  }

  /** True when at least one peer data channel is open. */
  hasOpenChannel(): boolean {
    for (const dc of this.dataChannels.values()) {
      if (dc.readyState === 'open') return true;
    }
    return false;
  }

  onMessage(handler: (data: ArrayBuffer | string) => void) {
    this.messageHandler = handler;
  }

  /**
   * Fan a frame out to every open data channel.
   *
   * Returns the number of peers the frame was actually handed to, so callers
   * can tell "sent to nobody" apart from "sent". Previously this returned void
   * and a write with no open channel was indistinguishable from a delivered one.
   */
  send(data: ArrayBuffer | string): number {
    let delivered = 0;
    for (const dc of this.dataChannels.values()) {
      if (dc.readyState === 'open') {
        try {
          if (typeof data === 'string') dc.send(data);
          else dc.send(data);
          delivered++;
        } catch (e) {
          console.warn('SyncForge: send error', e);
        }
      }
    }
    return delivered;
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    for (const pc of this.peers.values()) {
      pc.close();
    }
    this.peers.clear();
    this.dataChannels.clear();
  }
}
