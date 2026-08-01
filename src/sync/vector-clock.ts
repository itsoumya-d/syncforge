// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1619@gmail.com

export class VectorClock {
  private clocks: Record<string, number> = {};
  private localPeerId: string;

  constructor(localPeerId: string) {
    this.localPeerId = localPeerId;
    this.clocks[localPeerId] = 0;
  }

  /**
   * Stamp a new local operation.
   *
   * This follows the Lamport send rule: the returned timestamp is strictly
   * greater than every timestamp this replica has already observed, so a write
   * that happens-after a remote operation always carries a higher timestamp
   * than that operation.
   *
   * Previously this only incremented the local entry, which meant a replica
   * that had made fewer writes than a peer produced timestamps *below* the
   * timestamps it had already seen. Last-writer-wins then silently discarded
   * the replica's own local write.
   */
  increment(): number {
    let max = 0;
    for (const value of Object.values(this.clocks)) {
      if (value > max) max = value;
    }
    this.clocks[this.localPeerId] = max + 1;
    return this.clocks[this.localPeerId];
  }

  update(remoteClock: Record<string, number>): void {
    for (const [peerId, timestamp] of Object.entries(remoteClock)) {
      if (peerId === '__proto__' || peerId === 'constructor' || peerId === 'prototype') continue;
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp < 0) continue;
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
