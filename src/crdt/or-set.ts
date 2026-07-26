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

  merge(other: ORSet<T>): void {
    for (const id of other.removed) {
      this.remove(id);
    }
    for (const [id, value] of other.added.entries()) {
      if (!this.removed.has(id)) {
        this.added.set(id, value);
      }
    }
  }
}
