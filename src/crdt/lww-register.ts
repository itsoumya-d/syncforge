export class LWWRegister<T> {
  value: T | null;
  timestamp: number;
  peerId: string;

  constructor(value: T | null = null, timestamp: number = 0, peerId: string = '') {
    this.value = value;
    this.timestamp = timestamp;
    this.peerId = peerId;
  }

  set(value: T, timestamp: number, peerId: string): void {
    if (timestamp > this.timestamp || (timestamp === this.timestamp && peerId > this.peerId)) {
      this.value = value;
      this.timestamp = timestamp;
      this.peerId = peerId;
    }
  }

  merge(other: LWWRegister<T>): void {
    this.set(other.value as T, other.timestamp, other.peerId);
  }
}
