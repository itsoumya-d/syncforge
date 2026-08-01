// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1619@gmail.com

export class GCounter {
  counts: Record<string, number>;

  constructor(counts: Record<string, number> = {}) {
    this.counts = { ...counts };
  }

  increment(peerId: string, amount: number = 1): void {
    if (amount < 0) throw new Error('GCounter can only increment by positive amounts');
    this.counts[peerId] = (this.counts[peerId] || 0) + amount;
  }

  get value(): number {
    return Object.values(this.counts).reduce((sum, count) => sum + count, 0);
  }

  merge(other: GCounter): void {
    for (const [peerId, count] of Object.entries(other.counts)) {
      this.counts[peerId] = Math.max(this.counts[peerId] || 0, count);
    }
  }
}
