"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  Collection: () => Collection,
  EventEmitter: () => EventEmitter,
  GCounter: () => GCounter,
  IndexedDBAdapter: () => IndexedDBAdapter,
  LWWMap: () => LWWMap,
  LWWRegister: () => LWWRegister,
  MemoryAdapter: () => MemoryAdapter,
  ORSet: () => ORSet,
  PNCounter: () => PNCounter,
  Query: () => Query,
  SyncForge: () => SyncForge,
  SyncManager: () => SyncManager,
  VectorClock: () => VectorClock
});
module.exports = __toCommonJS(index_exports);

// src/license-validator.ts
var _LicenseValidator = class _LicenseValidator {
  /**
   * Read an environment variable without requiring @types/node.
   * `tsc --noEmit` previously reported four TS2580 errors here because the file
   * references the Node `process` global while tsconfig only includes DOM libs.
   */
  static env(name) {
    const proc = globalThis.process;
    const value = proc && proc.env ? proc.env[name] : void 0;
    return typeof value === "string" ? value : void 0;
  }
  static hasProcess() {
    return typeof globalThis.process !== "undefined";
  }
  static validate(options) {
    const key = options?.licenseKey || _LicenseValidator.env("COMMERCIAL_LICENSE_KEY");
    const isDev = typeof window !== "undefined" ? window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" : _LicenseValidator.hasProcess() && _LicenseValidator.env("NODE_ENV") !== "production";
    if (isDev || options?.allowEval) {
      return true;
    }
    if (!key || !key.startsWith("BSL11-")) {
      console.warn(
        "SyncForge: no commercial license key detected. Production use requires a paid license under the Business Source License 1.1. See COMMERCIAL_LICENSE.md or https://github.com/itsoumya-d/syncforge for terms. Set COMMERCIAL_LICENSE_KEY, or pass { allowEval: true } for evaluation use."
      );
      return false;
    }
    return true;
  }
};
_LicenseValidator.AUTHOR = "Soumya Debnath";
_LicenseValidator.CONTACT = "soumyadebnath1661@gmail.com";
var LicenseValidator = _LicenseValidator;

// src/query.ts
var Query = class {
  constructor(collection) {
    this._where = [];
    this.collection = collection;
  }
  where(field, op, value) {
    this._where.push({ field, op, value });
    return this;
  }
  orderBy(field, direction = "asc") {
    this._orderBy = { field, direction };
    return this;
  }
  limit(n) {
    this._limit = n;
    return this;
  }
  execute(docs) {
    let result = [...docs];
    for (const condition of this._where) {
      result = result.filter((doc) => {
        const docVal = doc[condition.field];
        switch (condition.op) {
          case "==":
            return docVal === condition.value;
          case "!=":
            return docVal !== condition.value;
          case ">":
            return docVal > condition.value;
          case "<":
            return docVal < condition.value;
          case ">=":
            return docVal >= condition.value;
          case "<=":
            return docVal <= condition.value;
          default:
            return false;
        }
      });
    }
    if (this._orderBy) {
      const { field, direction } = this._orderBy;
      result.sort((a, b) => {
        if (a[field] < b[field]) return direction === "asc" ? -1 : 1;
        if (a[field] > b[field]) return direction === "asc" ? 1 : -1;
        return 0;
      });
    }
    if (this._limit !== void 0) {
      result = result.slice(0, this._limit);
    }
    return result;
  }
  async get() {
    const docs = await this.collection.getAll();
    return this.execute(docs);
  }
  subscribe(callback) {
    return this.collection.subscribe((docs) => {
      callback(this.execute(docs));
    });
  }
};

// src/events.ts
var EventEmitter = class {
  constructor() {
    this.listeners = {};
  }
  on(event, callback) {
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
  emit(event, ...args) {
    const listeners = this.listeners[event];
    if (!listeners) return;
    for (const cb of listeners.slice()) {
      try {
        cb(...args);
      } catch (err) {
        console.error(`SyncForge: listener for "${event}" threw`, err);
      }
    }
  }
  off(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter((cb) => cb !== callback);
    }
  }
};

// src/crdt/lww-register.ts
var LWWRegister = class _LWWRegister {
  constructor(value = null, timestamp = 0, peerId = "") {
    this.value = value;
    this.timestamp = timestamp;
    this.peerId = peerId;
  }
  /**
   * Apply a write, keeping the winner of a total order on
   * (timestamp, peerId, value).
   *
   * The third level is required for convergence. With only (timestamp, peerId)
   * the case "same timestamp, same peer, different value" was unordered, so the
   * incumbent value was kept and `merge` stopped being commutative:
   * merge(a,b) !== merge(b,a). That is reachable in ordinary use, because the
   * documented usage passes `Date.now()` — a clock with 1 ms granularity — so
   * any two writes by the same peer inside the same millisecond tie. Measured:
   * 198 of 200 back-to-back writes were silently discarded, and two replicas
   * that each kept a different survivor never reconverged.
   *
   * Note that ties are therefore resolved by value order, not by wall-clock
   * arrival order. If you need "last write wins" between writes closer together
   * than your clock's resolution, supply a monotonically increasing counter
   * instead of `Date.now()` (this is what `Collection` does internally).
   */
  set(value, timestamp, peerId) {
    if (!this.wins(value, timestamp, peerId)) return;
    this.value = value;
    this.timestamp = timestamp;
    this.peerId = peerId;
  }
  wins(value, timestamp, peerId) {
    if (timestamp !== this.timestamp) return timestamp > this.timestamp;
    if (peerId !== this.peerId) return peerId > this.peerId;
    const incoming = _LWWRegister.rank(value);
    const current = _LWWRegister.rank(this.value);
    return incoming > current;
  }
  /** Stable, order-independent key used only as the final tie-break. */
  static rank(value) {
    if (value === void 0) return "\0undefined";
    try {
      return JSON.stringify(value) ?? "\0" + String(value);
    } catch {
      return "\0" + String(value);
    }
  }
  merge(other) {
    this.set(other.value, other.timestamp, other.peerId);
  }
};

// src/crdt/lww-map.ts
var _LWWMap = class _LWWMap {
  // 60s max drift allowed
  constructor() {
    this.data = /* @__PURE__ */ new Map();
  }
  isTimestampValid(timestamp) {
    const now = Date.now();
    return timestamp <= now + _LWWMap.MAX_FUTURE_DRIFT_MS && timestamp >= 0;
  }
  sanitizeKey(key) {
    return key !== "__proto__" && key !== "constructor" && key !== "prototype";
  }
  set(key, value, timestamp, peerId) {
    if (!this.sanitizeKey(key)) return;
    if (!this.isTimestampValid(timestamp)) return;
    if (!this.data.has(key) && this.data.size >= _LWWMap.MAX_KEYS) {
      console.warn(
        "SyncForge: LWWMap key limit (" + _LWWMap.MAX_KEYS + ') reached; dropping key "' + key + '". Replicas that reached the limit with a different key set will not converge.'
      );
      return;
    }
    if (!this.data.has(key)) {
      this.data.set(key, new LWWRegister(value, timestamp, peerId));
    } else {
      this.data.get(key).set(value, timestamp, peerId);
    }
  }
  get(key) {
    if (!this.sanitizeKey(key)) return void 0;
    const reg = this.data.get(key);
    return reg ? reg.value : void 0;
  }
  delete(key, timestamp, peerId) {
    if (!this.sanitizeKey(key)) return;
    if (!this.isTimestampValid(timestamp)) return;
    if (!this.data.has(key)) {
      if (this.data.size >= _LWWMap.MAX_KEYS) return;
      this.data.set(key, new LWWRegister(null, timestamp, peerId));
    } else {
      this.data.get(key).set(null, timestamp, peerId);
    }
  }
  toJSON() {
    const result = {};
    for (const [key, reg] of this.data.entries()) {
      if (reg.value !== null && reg.value !== void 0) {
        result[key] = reg.value;
      }
    }
    return result;
  }
  merge(other) {
    for (const [key, otherReg] of other.data.entries()) {
      if (!this.sanitizeKey(key)) continue;
      if (!this.isTimestampValid(otherReg.timestamp)) continue;
      if (!this.data.has(key)) {
        if (this.data.size < _LWWMap.MAX_KEYS) {
          this.data.set(key, new LWWRegister(otherReg.value, otherReg.timestamp, otherReg.peerId));
        }
      } else {
        this.data.get(key).merge(otherReg);
      }
    }
  }
  toBuffer() {
    const state = {};
    for (const [key, reg] of this.data.entries()) {
      state[key] = { value: reg.value, timestamp: reg.timestamp, peerId: reg.peerId };
    }
    const encoder = new TextEncoder();
    return encoder.encode(JSON.stringify(state)).buffer;
  }
  static fromBuffer(buffer) {
    const decoder = new TextDecoder();
    const map = new _LWWMap();
    try {
      const jsonStr = decoder.decode(buffer);
      const state = JSON.parse(jsonStr, (key, value) => {
        if (key === "__proto__" || key === "constructor" || key === "prototype") return void 0;
        return value;
      });
      if (state && typeof state === "object") {
        let count = 0;
        for (const [key, regData] of Object.entries(state)) {
          if (count >= _LWWMap.MAX_KEYS) break;
          if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
          if (regData && typeof regData === "object" && "value" in regData && "timestamp" in regData) {
            map.set(key, regData.value, Number(regData.timestamp) || 0, String(regData.peerId || ""));
            count++;
          }
        }
      }
    } catch (e) {
      console.warn("SyncForge: Failed to parse LWWMap buffer", e);
    }
    return map;
  }
  delta(sinceTimestamp) {
    const deltaMap = new _LWWMap();
    for (const [key, reg] of this.data.entries()) {
      if (reg.timestamp > sinceTimestamp) {
        deltaMap.data.set(key, new LWWRegister(reg.value, reg.timestamp, reg.peerId));
      }
    }
    return deltaMap;
  }
};
_LWWMap.MAX_KEYS = 1e4;
_LWWMap.MAX_FUTURE_DRIFT_MS = 6e4;
var LWWMap = _LWWMap;

// src/crdt/g-counter.ts
var GCounter = class {
  constructor(counts = {}) {
    this.counts = { ...counts };
  }
  increment(peerId, amount = 1) {
    if (amount < 0) throw new Error("GCounter can only increment by positive amounts");
    this.counts[peerId] = (this.counts[peerId] || 0) + amount;
  }
  get value() {
    return Object.values(this.counts).reduce((sum, count) => sum + count, 0);
  }
  merge(other) {
    for (const [peerId, count] of Object.entries(other.counts)) {
      this.counts[peerId] = Math.max(this.counts[peerId] || 0, count);
    }
  }
};

// src/crdt/pn-counter.ts
var PNCounter = class {
  constructor(positives = {}, negatives = {}) {
    this.positives = new GCounter(positives);
    this.negatives = new GCounter(negatives);
  }
  increment(peerId, amount = 1) {
    this.positives.increment(peerId, amount);
  }
  decrement(peerId, amount = 1) {
    this.negatives.increment(peerId, amount);
  }
  get value() {
    return this.positives.value - this.negatives.value;
  }
  merge(other) {
    this.positives.merge(other.positives);
    this.negatives.merge(other.negatives);
  }
};

// src/collection.ts
var Collection = class _Collection extends EventEmitter {
  constructor(name, db, storage, sync) {
    super();
    /**
     * Per-document serialisation chain.
     *
     * `applyOperationLocally` is a read-modify-write over the stored `_meta`
     * record. Without serialisation two overlapping operations on the same
     * document both read the same pre-state and the second write clobbers the
     * first, so e.g. `Promise.all([col.increment(...) x10])` produced 1 instead
     * of 10. Operations on the same document are now queued; operations on
     * different documents still run concurrently.
     */
    this.applyQueues = /* @__PURE__ */ new Map();
    this.name = name;
    this.db = db;
    this.storage = storage;
    this.sync = sync;
    this.sync.on("sync", (op) => {
      if (op.collection === this.name) {
        this.applyOperationLocally(op).catch((err) => {
          console.error("SyncForge: failed to apply remote operation", err);
        });
      }
    });
  }
  async set(id, data) {
    _Collection.assertSerialisable(data);
    const timestamp = this.sync.getVectorClock().increment();
    const op = {
      id: `${this.db.peerId}-${timestamp}`,
      type: "set",
      collection: this.name,
      docId: id,
      field: "",
      value: data,
      timestamp,
      peerId: this.db.peerId
    };
    this.sync.markApplied(op.id);
    await this.applyOperationLocally(op);
    await this.storage.saveOperation(op);
    this.sync.broadcast(op);
  }
  async get(id) {
    return this.storage.get(this.name, id);
  }
  async delete(id) {
    const timestamp = this.sync.getVectorClock().increment();
    const op = {
      id: `${this.db.peerId}-${timestamp}`,
      type: "delete",
      collection: this.name,
      docId: id,
      field: "",
      value: null,
      timestamp,
      peerId: this.db.peerId
    };
    this.sync.markApplied(op.id);
    await this.applyOperationLocally(op);
    await this.storage.saveOperation(op);
    this.sync.broadcast(op);
  }
  async getAll() {
    return this.storage.getAll(this.name);
  }
  where(field, op, value) {
    return new Query(this).where(field, op, value);
  }
  orderBy(field, direction = "asc") {
    return new Query(this).orderBy(field, direction);
  }
  limit(n) {
    return new Query(this).limit(n);
  }
  subscribe(callback) {
    const listener = async () => {
      const docs = await this.getAll();
      callback(docs);
    };
    this.on("change", listener);
    listener();
    return () => this.off("change", listener);
  }
  subscribeDoc(id, callback) {
    const listener = async (changedId) => {
      if (!changedId || changedId === id) {
        const doc = await this.get(id);
        callback(doc);
      }
    };
    this.on("change", listener);
    listener();
    return () => this.off("change", listener);
  }
  async increment(id, field, amount = 1) {
    const timestamp = this.sync.getVectorClock().increment();
    const op = {
      id: `${this.db.peerId}-${timestamp}`,
      type: "inc",
      collection: this.name,
      docId: id,
      field,
      value: amount,
      timestamp,
      peerId: this.db.peerId
    };
    this.sync.markApplied(op.id);
    await this.applyOperationLocally(op);
    await this.storage.saveOperation(op);
    this.sync.broadcast(op);
  }
  async decrement(id, field, amount = 1) {
    const timestamp = this.sync.getVectorClock().increment();
    const op = {
      id: `${this.db.peerId}-${timestamp}`,
      type: "dec",
      collection: this.name,
      docId: id,
      field,
      value: amount,
      timestamp,
      peerId: this.db.peerId
    };
    this.sync.markApplied(op.id);
    await this.applyOperationLocally(op);
    await this.storage.saveOperation(op);
    this.sync.broadcast(op);
  }
  /**
   * Queue `op` behind any in-flight operation for the same document, so the
   * read-modify-write below can never interleave with itself.
   */
  applyOperationLocally(op) {
    const key = String(op && op.docId);
    const previous = this.applyQueues.get(key) || Promise.resolve();
    const next = previous.catch(() => {
    }).then(() => this.applyOperationUnsafe(op));
    this.applyQueues.set(key, next);
    next.catch(() => {
    }).then(() => {
      if (this.applyQueues.get(key) === next) this.applyQueues.delete(key);
    });
    return next;
  }
  static assertSerialisable(data) {
    try {
      JSON.stringify(data);
    } catch (err) {
      throw new TypeError(
        "SyncForge: document value is not JSON-serialisable (circular reference or BigInt). Nothing was written. Original error: " + (err instanceof Error ? err.message.split("\n")[0] : String(err))
      );
    }
  }
  async applyOperationUnsafe(op) {
    const meta = await this.storage.get(`${this.name}_meta`, op.docId) || { mapData: {}, counterData: {} };
    const map = new LWWMap();
    if (meta.mapData) {
      for (const [k, v] of Object.entries(meta.mapData)) {
        map.set(k, v.value, v.timestamp, v.peerId);
      }
    }
    const counters = {};
    if (meta.counterData) {
      for (const [k, v] of Object.entries(meta.counterData)) {
        counters[k] = new PNCounter(v.positives, v.negatives);
      }
    }
    if (op.type === "set") {
      for (const [k, v] of Object.entries(op.value || {})) {
        map.set(k, v, op.timestamp, op.peerId);
      }
      map.set("_deleted", false, op.timestamp, op.peerId);
    } else if (op.type === "delete") {
      map.set("_deleted", true, op.timestamp, op.peerId);
    } else if (op.type === "inc") {
      if (!counters[op.field]) counters[op.field] = new PNCounter();
      counters[op.field].increment(op.peerId, op.value);
    } else if (op.type === "dec") {
      if (!counters[op.field]) counters[op.field] = new PNCounter();
      counters[op.field].decrement(op.peerId, op.value);
    }
    meta.mapData = {};
    for (const [k, reg] of map.data.entries()) {
      meta.mapData[k] = { value: reg.value, timestamp: reg.timestamp, peerId: reg.peerId };
    }
    meta.counterData = {};
    for (const [k, counter] of Object.entries(counters)) {
      meta.counterData[k] = { positives: counter.positives.counts, negatives: counter.negatives.counts };
    }
    await this.storage.set(`${this.name}_meta`, op.docId, meta);
    const docView = map.toJSON();
    for (const [k, counter] of Object.entries(counters)) {
      docView[k] = (docView[k] || 0) + counter.value;
    }
    const isDeleted = docView._deleted === true;
    delete docView._deleted;
    if (isDeleted) {
      await this.storage.delete(this.name, op.docId);
    } else {
      await this.storage.set(this.name, op.docId, docView);
    }
    this.emit("change", op.docId);
    this.db.emit("change", { collection: this.name, docId: op.docId });
  }
};

// src/sync/vector-clock.ts
var VectorClock = class {
  constructor(localPeerId) {
    this.clocks = {};
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
  increment() {
    let max = 0;
    for (const value of Object.values(this.clocks)) {
      if (value > max) max = value;
    }
    this.clocks[this.localPeerId] = max + 1;
    return this.clocks[this.localPeerId];
  }
  update(remoteClock) {
    for (const [peerId, timestamp] of Object.entries(remoteClock)) {
      if (peerId === "__proto__" || peerId === "constructor" || peerId === "prototype") continue;
      if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp < 0) continue;
      this.clocks[peerId] = Math.max(this.clocks[peerId] || 0, timestamp);
    }
  }
  getClock() {
    return { ...this.clocks };
  }
  getTimestamp() {
    return this.clocks[this.localPeerId] || 0;
  }
};

// src/sync/webrtc-transport.ts
var WebRTCTransport = class extends EventEmitter {
  constructor(peerId) {
    super();
    this.peers = /* @__PURE__ */ new Map();
    this.dataChannels = /* @__PURE__ */ new Map();
    this.ws = null;
    this.signalingUrl = "";
    this.roomId = "";
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.messageHandler = null;
    this.peerId = peerId;
  }
  connect(signalingUrl, roomId) {
    this.signalingUrl = signalingUrl;
    this.roomId = roomId;
    this.connectWebSocket();
  }
  connectWebSocket() {
    if (typeof WebSocket === "undefined") {
      this.emit("error", new Error("SyncForge: no WebSocket implementation available in this environment"));
      return;
    }
    try {
      this.ws = new WebSocket(this.signalingUrl);
    } catch (err) {
      this.emit("error", err);
      this.emit("signaling-failed", { url: this.signalingUrl, attempts: this.reconnectAttempts, cause: err });
      return;
    }
    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.emit("signaling-open", this.signalingUrl);
      this.ws?.send(JSON.stringify({ type: "join", roomId: this.roomId, peerId: this.peerId }));
    };
    this.ws.onerror = (event) => {
      this.emit("error", new Error("SyncForge: signaling socket error for " + this.signalingUrl));
      void event;
    };
    this.ws.onmessage = async (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        console.warn("SyncForge: Malformed WS message");
        return;
      }
      try {
        if (message.type === "peer-joined") {
          await this.handlePeerJoined(message.peerId);
        } else if (message.type === "offer") {
          await this.handleOffer(message.peerId, message.offer);
        } else if (message.type === "answer") {
          await this.handleAnswer(message.peerId, message.answer);
        } else if (message.type === "ice-candidate") {
          await this.handleIceCandidate(message.peerId, message.candidate);
        } else if (message.type === "peer-left") {
          this.handlePeerLeft(message.peerId);
        }
      } catch (err) {
        console.warn("SyncForge: Error handling signaling message", err);
      }
    };
    this.ws.onclose = () => {
      this.emit("signaling-closed", this.signalingUrl);
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        const backoff = Math.pow(2, this.reconnectAttempts) * 1e3;
        this.reconnectAttempts++;
        setTimeout(() => this.connectWebSocket(), backoff);
      } else {
        this.emit("signaling-failed", {
          url: this.signalingUrl,
          attempts: this.reconnectAttempts,
          cause: new Error("SyncForge: signaling unreachable after " + this.reconnectAttempts + " attempts")
        });
      }
    };
  }
  async handlePeerJoined(remotePeerId) {
    const pc = this.createPeerConnection(remotePeerId);
    const dc = this.createDataChannelForPeer(pc, "sync");
    this.setupDataChannel(remotePeerId, dc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.ws?.send(JSON.stringify({
      type: "offer",
      target: remotePeerId,
      peerId: this.peerId,
      offer
    }));
  }
  async handleOffer(remotePeerId, offer) {
    const existingPc = this.peers.get(remotePeerId);
    if (existingPc) {
      try {
        existingPc.close();
      } catch {
      }
      this.peers.delete(remotePeerId);
    }
    const pc = this.createPeerConnection(remotePeerId);
    pc.ondatachannel = (event) => {
      this.setupDataChannel(remotePeerId, event.channel);
    };
    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.ws?.send(JSON.stringify({
      type: "answer",
      target: remotePeerId,
      peerId: this.peerId,
      answer
    }));
  }
  async handleAnswer(remotePeerId, answer) {
    const pc = this.peers.get(remotePeerId);
    if (pc) {
      await pc.setRemoteDescription(answer);
    }
  }
  async handleIceCandidate(remotePeerId, candidate) {
    const pc = this.peers.get(remotePeerId);
    if (pc) {
      await pc.addIceCandidate(candidate);
    }
  }
  handlePeerLeft(remotePeerId) {
    const pc = this.peers.get(remotePeerId);
    if (pc) {
      pc.close();
      this.peers.delete(remotePeerId);
    }
    this.dataChannels.delete(remotePeerId);
  }
  createPeerConnection(remotePeerId) {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      this.emit("ice-state", { peerId: remotePeerId, state });
      if (state === "failed") {
        this.emit("peer-unreachable", {
          peerId: remotePeerId,
          reason: "ice-failed",
          hint: "No TURN relay is configured; symmetric/CGNAT peers cannot be reached over STUN alone."
        });
        this.dataChannels.delete(remotePeerId);
        this.emit("peer-disconnected", remotePeerId);
      } else if (state === "disconnected") {
        this.emit("peer-unreachable", { peerId: remotePeerId, reason: "ice-disconnected" });
      }
    };
    pc.onicecandidateerror = (event) => {
      this.emit("ice-candidate-error", {
        peerId: remotePeerId,
        errorCode: event && event.errorCode,
        errorText: event && event.errorText,
        url: event && event.url
      });
    };
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.ws?.send(JSON.stringify({
          type: "ice-candidate",
          target: remotePeerId,
          peerId: this.peerId,
          candidate: event.candidate
        }));
      }
    };
    this.peers.set(remotePeerId, pc);
    return pc;
  }
  createDataChannelForPeer(pc, label) {
    return pc.createDataChannel(label);
  }
  setupDataChannel(remotePeerId, dc) {
    dc.binaryType = "arraybuffer";
    dc.onopen = () => {
      this.dataChannels.set(remotePeerId, dc);
      this.emit("peer-connected", remotePeerId);
    };
    dc.onclose = () => {
      this.dataChannels.delete(remotePeerId);
      this.emit("peer-disconnected", remotePeerId);
    };
    dc.onmessage = (event) => {
      if (!this.messageHandler) return;
      try {
        this.messageHandler(event.data);
      } catch (err) {
        console.error("SyncForge: error handling peer message", err);
      }
    };
  }
  /** True when at least one peer data channel is open. */
  hasOpenChannel() {
    for (const dc of this.dataChannels.values()) {
      if (dc.readyState === "open") return true;
    }
    return false;
  }
  onMessage(handler) {
    this.messageHandler = handler;
  }
  /**
   * Fan a frame out to every open data channel.
   *
   * Returns the number of peers the frame was actually handed to, so callers
   * can tell "sent to nobody" apart from "sent". Previously this returned void
   * and a write with no open channel was indistinguishable from a delivered one.
   */
  send(data) {
    let delivered = 0;
    for (const dc of this.dataChannels.values()) {
      if (dc.readyState === "open") {
        try {
          if (typeof data === "string") dc.send(data);
          else dc.send(data);
          delivered++;
        } catch (e) {
          console.warn("SyncForge: send error", e);
        }
      }
    }
    return delivered;
  }
  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    for (const pc of this.peers.values()) {
      pc.close();
    }
    this.peers.clear();
    this.dataChannels.clear();
  }
};

// src/sync/sync-manager.ts
var _SyncManager = class _SyncManager extends EventEmitter {
  constructor(peerId) {
    super();
    this.connected = false;
    /**
     * Operation ids already applied, for at-least-once delivery.
     *
     * `set`/`delete` are idempotent (last-writer-wins), but `inc`/`dec` are not:
     * re-applying an increment adds the amount again. Without dedup, duplicate
     * delivery (a retry, a resync, or `importData()` of a snapshot that overlaps
     * the local log) permanently diverged counters between replicas.
     *
     * Bounded FIFO so a long-lived session cannot grow it without limit.
     */
    this.appliedOps = /* @__PURE__ */ new Set();
    this.appliedOrder = [];
    this.peerId = peerId;
    this.vectorClock = new VectorClock(peerId);
    this.transport = new WebRTCTransport(peerId);
    this.transport.onMessage((data) => {
      this.handleRemoteData(data);
    });
    this.transport.on("peer-connected", (peerId2) => {
      const wasConnected = this.connected;
      this.connected = true;
      this.emit("peer-connected", peerId2);
      if (!wasConnected) this.emit("online");
    });
    this.transport.on("peer-disconnected", (peerId2) => {
      this.emit("peer-disconnected", peerId2);
      if (!this.transport.hasOpenChannel()) {
        if (this.connected) this.emit("offline");
        this.connected = false;
      }
    });
    this.transport.on("peer-unreachable", (info) => this.emit("peer-unreachable", info));
    this.transport.on("ice-state", (info) => this.emit("ice-state", info));
    this.transport.on("ice-candidate-error", (info) => this.emit("ice-candidate-error", info));
    this.transport.on("error", (err) => this.emit("error", err));
    this.transport.on("signaling-failed", (info) => {
      if (this.connected) this.emit("offline");
      this.connected = false;
      this.emit("signaling-failed", info);
      this.emit("error", info && info.cause || new Error("SyncForge: signaling unreachable"));
    });
  }
  /**
   * Begin connecting.
   *
   * This does NOT mean the peer is online. `connect()` used to set
   * `connected = true` and emit 'online' synchronously, before the signaling
   * socket had even opened — so the caller was told it was online even when the
   * host did not exist, and was never told otherwise. 'online' is now emitted
   * when the first peer data channel actually opens, and 'offline' when the
   * last one closes or signaling fails permanently.
   */
  connect(signalingUrl, roomId = "default-room") {
    this.emit("connecting", { signalingUrl, roomId });
    this.transport.connect(signalingUrl, roomId);
  }
  /** True only when at least one peer data channel is open. */
  isConnected() {
    return this.connected;
  }
  disconnect() {
    this.transport.disconnect();
    this.connected = false;
    this.emit("offline");
  }
  /**
   * Encode and fan out an operation.
   *
   * Returns the number of peers it reached. 0 means the operation exists only
   * locally: there is no outbox, so it will NOT be retried or replayed when a
   * peer later connects. Callers that need guaranteed propagation must track
   * this themselves (see `exportData()` / `importData()`).
   */
  broadcast(operation) {
    if (!this.connected) return 0;
    const encoder = new TextEncoder();
    let clockBytes;
    let typeBytes;
    let collectionBytes;
    let docIdBytes;
    let dataBytes;
    try {
      clockBytes = encoder.encode(JSON.stringify(this.vectorClock.getClock()));
      typeBytes = encoder.encode(operation.type);
      collectionBytes = encoder.encode(operation.collection);
      docIdBytes = encoder.encode(operation.docId);
      dataBytes = encoder.encode(JSON.stringify(operation));
    } catch (e) {
      console.error("SyncForge: operation could not be serialised for broadcast", e);
      return 0;
    }
    if (clockBytes.length > 65535 || typeBytes.length > 255 || collectionBytes.length > 65535 || docIdBytes.length > 65535) {
      console.error(
        "SyncForge: refusing to broadcast operation \u2014 a header field exceeds its wire limit (clock=" + clockBytes.length + "/65535, type=" + typeBytes.length + "/255, collection=" + collectionBytes.length + "/65535, docId=" + docIdBytes.length + "/65535). The write is stored locally but was not sent."
      );
      return 0;
    }
    const buffer = new ArrayBuffer(2 + clockBytes.length + 1 + typeBytes.length + 2 + collectionBytes.length + 2 + docIdBytes.length + 4 + dataBytes.length);
    const view = new DataView(buffer);
    let offset = 0;
    view.setUint16(offset, clockBytes.length);
    offset += 2;
    new Uint8Array(buffer, offset, clockBytes.length).set(clockBytes);
    offset += clockBytes.length;
    view.setUint8(offset, typeBytes.length);
    offset += 1;
    new Uint8Array(buffer, offset, typeBytes.length).set(typeBytes);
    offset += typeBytes.length;
    view.setUint16(offset, collectionBytes.length);
    offset += 2;
    new Uint8Array(buffer, offset, collectionBytes.length).set(collectionBytes);
    offset += collectionBytes.length;
    view.setUint16(offset, docIdBytes.length);
    offset += 2;
    new Uint8Array(buffer, offset, docIdBytes.length).set(docIdBytes);
    offset += docIdBytes.length;
    view.setUint32(offset, dataBytes.length);
    offset += 4;
    new Uint8Array(buffer, offset, dataBytes.length).set(dataBytes);
    offset += dataBytes.length;
    return this.transport.send(buffer);
  }
  /**
   * Decode an inbound frame.
   *
   * Every length field is attacker-controlled: a peer only needs the room id to
   * send arbitrary bytes (there is no authentication). Previously the header
   * parse sat *outside* the try/catch, so a 1-byte frame threw
   * `RangeError: Offset is outside the bounds of the DataView` straight out of
   * the data-channel `onmessage` handler, and a frame declaring a huge length
   * threw `RangeError: Invalid typed array length`. Every read is now bounds
   * checked against the real buffer length and the whole body is guarded.
   */
  handleRemoteData(data) {
    if (typeof data === "string") return;
    if (!data || typeof data.byteLength !== "number") return;
    try {
      const total = data.byteLength;
      const view = new DataView(data);
      let offset = 0;
      const decoder = new TextDecoder();
      if (total < 11) {
        console.warn("SyncForge: dropping truncated frame", total, "bytes");
        return;
      }
      const need = (n) => {
        if (n < 0 || offset + n > total) {
          console.warn("SyncForge: dropping malformed frame (declared length exceeds payload)");
          return false;
        }
        return true;
      };
      const clockLen = view.getUint16(offset);
      offset += 2;
      if (!need(clockLen)) return;
      const clockStr = decoder.decode(new Uint8Array(data, offset, clockLen));
      offset += clockLen;
      if (!need(1)) return;
      const typeLen = view.getUint8(offset);
      offset += 1;
      if (!need(typeLen)) return;
      offset += typeLen;
      if (!need(2)) return;
      const collectionLen = view.getUint16(offset);
      offset += 2;
      if (!need(collectionLen)) return;
      offset += collectionLen;
      if (!need(2)) return;
      const docIdLen = view.getUint16(offset);
      offset += 2;
      if (!need(docIdLen)) return;
      offset += docIdLen;
      if (!need(4)) return;
      const dataLen = view.getUint32(offset);
      offset += 4;
      if (!need(dataLen)) return;
      const dataStr = decoder.decode(new Uint8Array(data, offset, dataLen));
      offset += dataLen;
      const clock = JSON.parse(clockStr);
      const operation = JSON.parse(dataStr);
      if (clock && typeof clock === "object") this.vectorClock.update(clock);
      this.receive(operation);
    } catch (e) {
      console.error("SyncForge: failed to parse remote operation", e);
    }
  }
  onRemoteOperation(callback) {
    this.on("sync", callback);
  }
  /**
   * Apply an operation received from a peer (or replayed from a snapshot).
   *
   * Duplicates are dropped by operation id so that at-least-once delivery is
   * safe for the non-idempotent `inc`/`dec` operations.
   */
  receive(operation) {
    if (!operation || typeof operation !== "object") return;
    const id = operation.id;
    if (typeof id === "string" && id.length > 0) {
      if (this.appliedOps.has(id)) return;
      this.appliedOps.add(id);
      this.appliedOrder.push(id);
      if (this.appliedOrder.length > _SyncManager.MAX_APPLIED_OPS) {
        const evicted = this.appliedOrder.shift();
        if (evicted !== void 0) this.appliedOps.delete(evicted);
      }
    }
    if (typeof operation.peerId === "string" && typeof operation.timestamp === "number") {
      this.vectorClock.update({ [operation.peerId]: operation.timestamp });
    }
    this.emit("sync", operation);
  }
  /** Record a locally generated operation id so an echo of it is ignored. */
  markApplied(operationId) {
    if (typeof operationId !== "string" || operationId.length === 0) return;
    if (this.appliedOps.has(operationId)) return;
    this.appliedOps.add(operationId);
    this.appliedOrder.push(operationId);
    if (this.appliedOrder.length > _SyncManager.MAX_APPLIED_OPS) {
      const evicted = this.appliedOrder.shift();
      if (evicted !== void 0) this.appliedOps.delete(evicted);
    }
  }
  getVectorClock() {
    return this.vectorClock;
  }
};
_SyncManager.MAX_APPLIED_OPS = 1e5;
var SyncManager = _SyncManager;

// src/storage/indexeddb-adapter.ts
var IndexedDBAdapter = class {
  constructor(dbName) {
    this.db = null;
    this.dbName = dbName;
    this.ready = this.init();
  }
  init() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        resolve();
        return;
      }
      const request = indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains("documents")) {
          db.createObjectStore("documents", { keyPath: ["collection", "id"] });
        }
        if (!db.objectStoreNames.contains("operations")) {
          db.createObjectStore("operations", { keyPath: "id" });
        }
      };
      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve();
      };
      request.onerror = () => {
        reject(request.error);
      };
    });
  }
  async get(collection, id) {
    await this.ready;
    if (!this.db) return null;
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction("documents", "readonly");
      const store = transaction.objectStore("documents");
      const request = store.get([collection, id]);
      request.onsuccess = () => resolve(request.result?.data || null);
      request.onerror = () => reject(request.error);
    });
  }
  async set(collection, id, data) {
    await this.ready;
    if (!this.db) return;
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction("documents", "readwrite");
      const store = transaction.objectStore("documents");
      const request = store.put({ collection, id, data });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
  async delete(collection, id) {
    await this.ready;
    if (!this.db) return;
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction("documents", "readwrite");
      const store = transaction.objectStore("documents");
      const request = store.delete([collection, id]);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
  async getAll(collection) {
    await this.ready;
    if (!this.db) return [];
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction("documents", "readonly");
      const store = transaction.objectStore("documents");
      const request = store.getAll();
      request.onsuccess = () => {
        const results = request.result.filter((item) => item.collection === collection).map((item) => item.data);
        resolve(results);
      };
      request.onerror = () => reject(request.error);
    });
  }
  async saveOperation(op) {
    await this.ready;
    if (!this.db) return;
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction("operations", "readwrite");
      const store = transaction.objectStore("operations");
      const request = store.put(op);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
  async getOperations() {
    await this.ready;
    if (!this.db) return [];
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction("operations", "readonly");
      const store = transaction.objectStore("operations");
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
};

// src/storage/memory-adapter.ts
var MemoryAdapter = class {
  constructor() {
    /**
     * Map-backed store.
     *
     * This used to be a plain object indexed by the collection name, so a
     * collection called `__proto__` resolved `this.collections['__proto__']` to
     * `Object.prototype` (truthy, so the initialiser was skipped) and the next
     * line wrote a document straight onto `Object.prototype` — process-wide
     * prototype pollution. A document id of `__proto__` likewise reassigned the
     * collection object's prototype. `Map` keys cannot collide with prototype
     * members, which closes both vectors.
     */
    this.collections = /* @__PURE__ */ new Map();
    this.operations = [];
  }
  async get(collection, id) {
    const store = this.collections.get(collection);
    if (!store) return null;
    const value = store.get(id);
    return value === void 0 ? null : value;
  }
  async set(collection, id, data) {
    let store = this.collections.get(collection);
    if (!store) {
      store = /* @__PURE__ */ new Map();
      this.collections.set(collection, store);
    }
    store.set(id, data);
  }
  async delete(collection, id) {
    this.collections.get(collection)?.delete(id);
  }
  async getAll(collection) {
    const store = this.collections.get(collection);
    if (!store) return [];
    return Array.from(store.values());
  }
  async saveOperation(op) {
    this.operations.push(op);
  }
  async getOperations() {
    return [...this.operations];
  }
};

// src/syncforge.ts
var SyncForge = class extends EventEmitter {
  constructor(options) {
    LicenseValidator.validate(options);
    super();
    this.collections = /* @__PURE__ */ new Map();
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("SyncForge: options must be an object, e.g. new SyncForge({ dbName: 'my-app' })");
    }
    if (typeof options.dbName !== "string" || options.dbName.length === 0) {
      throw new TypeError("SyncForge: options.dbName is required and must be a non-empty string");
    }
    if (options.peerId !== void 0 && (typeof options.peerId !== "string" || options.peerId.length === 0)) {
      throw new TypeError("SyncForge: options.peerId must be a non-empty string when provided");
    }
    this.dbName = options.dbName;
    this.peerId = options.peerId || Math.random().toString(36).substring(2, 9);
    if (typeof indexedDB !== "undefined") {
      this.storage = new IndexedDBAdapter(this.dbName);
    } else {
      this.storage = new MemoryAdapter();
    }
    this.syncManager = new SyncManager(this.peerId);
    this.syncManager.on("online", () => this.emit("online"));
    this.syncManager.on("offline", () => this.emit("offline"));
    this.syncManager.on("sync", (op) => this.emit("sync", op));
    this.syncManager.on("connecting", (info) => this.emit("connecting", info));
    this.syncManager.on("peer-connected", (id) => this.emit("peer-connected", id));
    this.syncManager.on("peer-disconnected", (id) => this.emit("peer-disconnected", id));
    this.syncManager.on("peer-unreachable", (info) => this.emit("peer-unreachable", info));
    this.syncManager.on("ice-state", (info) => this.emit("ice-state", info));
    this.syncManager.on("ice-candidate-error", (info) => this.emit("ice-candidate-error", info));
    this.syncManager.on("signaling-failed", (info) => this.emit("signaling-failed", info));
    this.syncManager.on("error", (err) => this.emit("error", err));
  }
  /** True only when at least one peer data channel is open. */
  isOnline() {
    return this.syncManager.isConnected();
  }
  collection(name) {
    if (!this.collections.has(name)) {
      this.collections.set(name, new Collection(name, this, this.storage, this.syncManager));
    }
    return this.collections.get(name);
  }
  connectPeer(signalingUrl) {
    this.syncManager.connect(signalingUrl);
  }
  disconnect() {
    this.syncManager.disconnect();
  }
  async exportData() {
    const ops = await this.storage.getOperations();
    return JSON.stringify(ops);
  }
  /**
   * Replay an operation log produced by `exportData()`.
   *
   * Operations already applied are skipped by operation id, so importing the
   * same snapshot twice is now a no-op. Previously every `inc`/`dec` in the
   * snapshot was applied again, so `importData(await exportData())` silently
   * doubled every counter in the database.
   */
  async importData(json) {
    let ops;
    try {
      ops = JSON.parse(json);
    } catch (e) {
      throw new SyntaxError("SyncForge: importData received invalid JSON: " + (e instanceof Error ? e.message : String(e)));
    }
    if (!Array.isArray(ops)) {
      throw new TypeError("SyncForge: importData expects a JSON array of operations");
    }
    for (const op of ops) {
      this.syncManager.receive(op);
    }
  }
};

// src/crdt/or-set.ts
var ORSet = class _ORSet {
  constructor() {
    this.added = /* @__PURE__ */ new Map();
    this.removed = /* @__PURE__ */ new Set();
  }
  // Use a unique ID for each element addition (e.g., peerId + timestamp)
  add(id, value) {
    if (!this.removed.has(id)) {
      this.added.set(id, value);
    }
  }
  remove(id) {
    this.removed.add(id);
    this.added.delete(id);
  }
  get values() {
    return Array.from(this.added.values());
  }
  has(value) {
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
  merge(other) {
    for (const id of other.removed) {
      this.remove(id);
    }
    for (const [id, value] of other.added.entries()) {
      if (this.removed.has(id)) continue;
      if (!this.added.has(id)) {
        this.added.set(id, value);
        continue;
      }
      const mine = this.added.get(id);
      if (mine === value) continue;
      if (_ORSet.rank(value) < _ORSet.rank(mine)) {
        this.added.set(id, value);
      }
    }
  }
  /** Stable, order-independent key used only to break tag-collision ties. */
  static rank(value) {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Collection,
  EventEmitter,
  GCounter,
  IndexedDBAdapter,
  LWWMap,
  LWWRegister,
  MemoryAdapter,
  ORSet,
  PNCounter,
  Query,
  SyncForge,
  SyncManager,
  VectorClock
});
//# sourceMappingURL=index.js.map