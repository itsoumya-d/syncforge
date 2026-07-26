// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1661@gmail.com | +91 7031648617

export class VectorClock {
  private clocks: Record<string, number> = {};
  private localPeerId: string;

  constructor(localPeerId: string) {
    this.localPeerId = localPeerId;
    this.clocks[localPeerId] = 0;
  }

  increment(): number {
    this.clocks[this.localPeerId] = (this.clocks[this.localPeerId] || 0) + 1;
    return this.clocks[this.localPeerId];
  }

  update(remoteClock: Record<string, number>): void {
    for (const [peerId, timestamp] of Object.entries(remoteClock)) {
      this.clocks[peerId] = Math.max(this.clocks[peerId] || 0, timestamp);
    }
  }

  getClock(): Record<string, number> {
    return { ...this.clocks };
  }

  getTimestamp(): number {
    return this.clocks[this.localPeerId] || 0;
  }
}
