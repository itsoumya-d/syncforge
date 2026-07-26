// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1661@gmail.com | +91 7031648617

import { LWWRegister } from './lww-register';

export class LWWMap {
  data: Map<string, LWWRegister<any>>;

  constructor() {
    this.data = new Map();
  }

  set(key: string, value: any, timestamp: number, peerId: string): void {
    if (!this.data.has(key)) {
      this.data.set(key, new LWWRegister(value, timestamp, peerId));
    } else {
      this.data.get(key)!.set(value, timestamp, peerId);
    }
  }

  get(key: string): any {
    const reg = this.data.get(key);
    return reg ? reg.value : undefined;
  }

  delete(key: string, timestamp: number, peerId: string): void {
    // Tombstone deletion
    if (!this.data.has(key)) {
      this.data.set(key, new LWWRegister(null, timestamp, peerId));
    } else {
      this.data.get(key)!.set(null, timestamp, peerId);
    }
  }

  toJSON(): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [key, reg] of this.data.entries()) {
      if (reg.value !== null && reg.value !== undefined) {
        result[key] = reg.value;
      }
    }
    return result;
  }

  merge(other: LWWMap): void {
    for (const [key, otherReg] of other.data.entries()) {
      if (!this.data.has(key)) {
        this.data.set(key, new LWWRegister(otherReg.value, otherReg.timestamp, otherReg.peerId));
      } else {
        this.data.get(key)!.merge(otherReg);
      }
    }
  }
}
