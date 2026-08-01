// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1619@gmail.com

export class EventEmitter {
  private listeners: Record<string, Function[]> = {};

  on(event: string, callback: Function): void {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(callback);
  }

  /**
   * Notify listeners. Each listener is isolated: a listener that throws is
   * reported and the remaining listeners still run.
   *
   * Previously a single throwing listener aborted the whole dispatch loop.
   * Because `emit('change', ...)` is called synchronously from inside
   * `Collection.applyOperationLocally`, one buggy application callback both
   * starved every later subscriber and made an already-persisted `set()`
   * reject — leaving the caller unable to tell whether the write landed.
   */
  emit(event: string, ...args: any[]): void {
    const listeners = this.listeners[event];
    if (!listeners) return;
    // Iterate a copy so a listener that calls on()/off() cannot corrupt the walk.
    for (const cb of listeners.slice()) {
      try {
        cb(...args);
      } catch (err) {
        console.error(`SyncForge: listener for "${event}" threw`, err);
      }
    }
  }

  off(event: string, callback: Function): void {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter((cb) => cb !== callback);
    }
  }
}
