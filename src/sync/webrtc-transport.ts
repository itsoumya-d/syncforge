// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1661@gmail.com | +91 7031648617

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
    this.ws = new WebSocket(this.signalingUrl);
    
    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.ws?.send(JSON.stringify({ type: 'join', roomId: this.roomId, peerId: this.peerId }));
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
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        const backoff = Math.pow(2, this.reconnectAttempts) * 1000;
        this.reconnectAttempts++;
        setTimeout(() => this.connectWebSocket(), backoff);
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
      if (this.messageHandler) {
        this.messageHandler(event.data);
      }
    };
  }

  onMessage(handler: (data: ArrayBuffer | string) => void) {
    this.messageHandler = handler;
  }

  send(data: ArrayBuffer | string) {
    for (const dc of this.dataChannels.values()) {
      if (dc.readyState === 'open') {
        try {
          dc.send(data);
        } catch (e) {
          console.warn('SyncForge: send error', e);
        }
      }
    }
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
