// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1661@gmail.com

export class ORSet<T> {
  added: Map<string, T>;
  removed: Set<string>;

  constructor() {
    this.added = new Map();
    this.removed = new Set();
  }

  // Use a unique ID for each element addition (e.g., peerId + timestamp)
  add(id: string, value: T): void {
    if (!this.removed.has(id)) {
      this.added.set(id, value);
    }
  }

  remove(id: string): void {
    this.removed.add(id);
    this.added.delete(id);
  }

  get values(): T[] {
    return Array.from(this.added.values());
  }

  has(value: T): boolean {
    for (const v of this.added.values()) {
      if (v === value) return true;
    }
    return false;
  }

  /**
   * Merge another replica's state into this one.
   *
   * A tag is supposed to identify a single add event, so the value bound to a
   * tag should be immutable. Nothing enforces that, and this used to blindly
   * overwrite: if two replicas bound the same tag to different values, then
   * `A.merge(B)` and `B.merge(A)` produced different results and the replicas
   * never reconverged. (Property test counterexample: A={t1:'apple'},
   * B={t1:'banana'} -> ['banana'] vs ['apple'].)
   *
   * Conflicting bindings are now resolved by a deterministic total order on the
   * serialised value, which makes merge commutative and associative regardless
   * of how the tags were generated.
   */
  merge(other: ORSet<T>): void {
    for (const id of other.removed) {
      this.remove(id);
    }
    for (const [id, value] of other.added.entries()) {
      if (this.removed.has(id)) continue;
      if (!this.added.has(id)) {
        this.added.set(id, value);
        continue;
      }
      const mine = this.added.get(id) as T;
      if (mine === value) continue;
      // Same tag, two different values: pick deterministically.
      if (ORSet.rank(value) < ORSet.rank(mine)) {
        this.added.set(id, value);
      }
    }
  }

  /** Stable, order-independent key used only to break tag-collision ties. */
  private static rank(value: unknown): string {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
}
