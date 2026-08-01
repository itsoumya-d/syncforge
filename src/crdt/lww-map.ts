// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1619@gmail.com

import { LWWRegister } from './lww-register';

export class LWWMap {
  data: Map<string, LWWRegister<any>>;
  private static readonly MAX_KEYS = 10000;
  private static readonly MAX_FUTURE_DRIFT_MS = 60000; // 60s max drift allowed

  constructor() {
    this.data = new Map();
  }

  private isTimestampValid(timestamp: number): boolean {
    const now = Date.now();
    // Prevent far-future timestamps (MAX_SAFE_INTEGER attack)
    return timestamp <= now + LWWMap.MAX_FUTURE_DRIFT_MS && timestamp >= 0;
  }

  private sanitizeKey(key: string): boolean {
    // Prevent prototype pollution
    return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
  }

  set(key: string, value: any, timestamp: number, peerId: string): void {
    if (!this.sanitizeKey(key)) return;
    if (!this.isTimestampValid(timestamp)) return;
    if (!this.data.has(key) && this.data.size >= LWWMap.MAX_KEYS) {
      // The cap is a state-bomb mitigation, but dropping a write silently means
      // two replicas that learned keys in a different order keep different key
      // sets and never reconverge. At minimum make it observable.
      console.warn(
        'SyncForge: LWWMap key limit (' + LWWMap.MAX_KEYS + ') reached; dropping key "' + key +
        '". Replicas that reached the limit with a different key set will not converge.'
      );
      return;
    }

    if (!this.data.has(key)) {
      this.data.set(key, new LWWRegister(value, timestamp, peerId));
    } else {
      this.data.get(key)!.set(value, timestamp, peerId);
    }
  }

  get(key: string): any {
    if (!this.sanitizeKey(key)) return undefined;
    const reg = this.data.get(key);
    return reg ? reg.value : undefined;
  }

  delete(key: string, timestamp: number, peerId: string): void {
    if (!this.sanitizeKey(key)) return;
    if (!this.isTimestampValid(timestamp)) return;

    // Tombstone deletion
    if (!this.data.has(key)) {
      if (this.data.size >= LWWMap.MAX_KEYS) return;
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
      if (!this.sanitizeKey(key)) continue;
      if (!this.isTimestampValid(otherReg.timestamp)) continue;

      if (!this.data.has(key)) {
        // Growth is already bounded by MAX_KEYS below. The old code also
        // counted *updates to existing keys* against the same budget and
        // `break`-ed out of the loop, so merging a full 10 000-key map into a
        // map that already had one key silently discarded a key even though
        // updating an existing register cannot grow the state at all.
        if (this.data.size < LWWMap.MAX_KEYS) {
          this.data.set(key, new LWWRegister(otherReg.value, otherReg.timestamp, otherReg.peerId));
        }
      } else {
        this.data.get(key)!.merge(otherReg);
      }
    }
  }

  toBuffer(): ArrayBuffer {
    const state: Record<string, any> = {};
    for (const [key, reg] of this.data.entries()) {
      state[key] = { value: reg.value, timestamp: reg.timestamp, peerId: reg.peerId };
    }
    const encoder = new TextEncoder();
    return encoder.encode(JSON.stringify(state)).buffer;
  }

  static fromBuffer(buffer: ArrayBuffer): LWWMap {
    const decoder = new TextDecoder();
    const map = new LWWMap();
    try {
      const jsonStr = decoder.decode(buffer);
      const state = JSON.parse(jsonStr, (key, value) => {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
        return value;
      });
      if (state && typeof state === 'object') {
        let count = 0;
        for (const [key, regData] of Object.entries(state)) {
          if (count >= LWWMap.MAX_KEYS) break;
          if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
          if (regData && typeof regData === 'object' && 'value' in regData && 'timestamp' in regData) {
            map.set(key, (regData as any).value, Number((regData as any).timestamp) || 0, String((regData as any).peerId || ''));
            count++;
          }
        }
      }
    } catch (e) {
      console.warn('SyncForge: Failed to parse LWWMap buffer', e);
    }
    return map;
  }

  delta(sinceTimestamp: number): LWWMap {
    const deltaMap = new LWWMap();
    for (const [key, reg] of this.data.entries()) {
      if (reg.timestamp > sinceTimestamp) {
        deltaMap.data.set(key, new LWWRegister(reg.value, reg.timestamp, reg.peerId));
      }
    }
    return deltaMap;
  }
}

