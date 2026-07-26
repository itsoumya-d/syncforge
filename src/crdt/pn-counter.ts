import { GCounter } from './g-counter';

export class PNCounter {
  positives: GCounter;
  negatives: GCounter;

  constructor(positives: Record<string, number> = {}, negatives: Record<string, number> = {}) {
    this.positives = new GCounter(positives);
    this.negatives = new GCounter(negatives);
  }

  increment(peerId: string, amount: number = 1): void {
    this.positives.increment(peerId, amount);
  }

  decrement(peerId: string, amount: number = 1): void {
    this.negatives.increment(peerId, amount);
  }

  get value(): number {
    return this.positives.value - this.negatives.value;
  }

  merge(other: PNCounter): void {
    this.positives.merge(other.positives);
    this.negatives.merge(other.negatives);
  }
}
