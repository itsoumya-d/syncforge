// src/license-validator.ts
var LicenseValidator = class {
  static validate(options) {
    const key = options?.licenseKey || (typeof process !== "undefined" ? process.env.COMMERCIAL_LICENSE_KEY : void 0);
    const isDev = typeof window !== "undefined" ? window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" : typeof process !== "undefined" && process.env.NODE_ENV !== "production";
    if (isDev || options?.allowEval) {
      return true;
    }
    if (!key || !key.startsWith("BSL11-")) {
      console.warn(`
================================================================================
\u{1F512} COMMERCIAL USE WARNING \u2014 BUSINESS SOURCE LICENSE 1.1 REQUIRED
Product: SYNCFORGE | Copyright (c) 2024-2026 Soumya Debnath

Production use of this software requires a valid paid commercial license key.
Unlicensed commercial deployment constitutes copyright infringement under DMCA \xA7 1201.

Purchase a commercial license key:
\u{1F4E7} Email: soumyadebnath1661@gmail.com | \u{1F4DE} Phone: +91 7031648617
================================================================================
      `);
      return false;
    }
    return true;
  }
};
LicenseValidator.AUTHOR = "Soumya Debnath";
LicenseValidator.CONTACT = "soumyadebnath1661@gmail.com";

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
  emit(event, ...args) {
    if (this.listeners[event]) {
      this.listeners[event].forEach((cb) => cb(...args));
    }
  }
  off(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter((cb) => cb !== callback);
    }
  }
};

// src/crdt/lww-register.ts
var LWWRegister = class {
  constructor(value = null, timestamp = 0, peerId = "") {
    this.value = value;
    this.timestamp = timestamp;
    this.peerId = peerId;
  }
  set(value, timestamp, peerId) {
    if (timestamp > this.timestamp || timestamp === this.timestamp && peerId > this.peerId) {
      this.value = value;
      this.timestamp = timestamp;
      this.peerId = peerId;
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
    if (!this.data.has(key) && this.data.size >= _LWWMap.MAX_KEYS) return;
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
    let mergedCount = 0;
    for (const [key, otherReg] of other.data.entries()) {
      if (!this.sanitizeKey(key)) continue;
      if (!this.isTimestampValid(otherReg.timestamp)) continue;
      if (mergedCount >= _LWWMap.MAX_KEYS) break;
      if (!this.data.has(key)) {
        if (this.data.size < _LWWMap.MAX_KEYS) {
          this.data.set(key, new LWWRegister(otherReg.value, otherReg.timestamp, otherReg.peerId));
          mergedCount++;
        }
      } else {
        this.data.get(key).merge(otherReg);
        mergedCount++;
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
var Collection = class extends EventEmitter {
  constructor(name, db, storage, sync) {
    super();
    this.name = name;
    this.db = db;
    this.storage = storage;
    this.sync = sync;
    this.sync.on("sync", async (op) => {
      if (op.collection === this.name) {
        await this.applyOperationLocally(op);
      }
    });
  }
  async set(id, data) {
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
    await this.applyOperationLocally(op);
    await this.storage.saveOperation(op);
    this.sync.broadcast(op);
  }
  async applyOperationLocally(op) {
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
    if (docView._deleted) {
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
  increment() {
    this.clocks[this.localPeerId] = (this.clocks[this.localPeerId] || 0) + 1;
    return this.clocks[this.localPeerId];
  }
  update(remoteClock) {
    for (const [peerId, timestamp] of Object.entries(remoteClock)) {
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
    this.ws = new WebSocket(this.signalingUrl);
    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.ws?.send(JSON.stringify({ type: "join", roomId: this.roomId, peerId: this.peerId }));
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
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        const backoff = Math.pow(2, this.reconnectAttempts) * 1e3;
        this.reconnectAttempts++;
        setTimeout(() => this.connectWebSocket(), backoff);
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
      if (this.messageHandler) {
        this.messageHandler(event.data);
      }
    };
  }
  onMessage(handler) {
    this.messageHandler = handler;
  }
  send(data) {
    for (const dc of this.dataChannels.values()) {
      if (dc.readyState === "open") {
        try {
          dc.send(data);
        } catch (e) {
          console.warn("SyncForge: send error", e);
        }
      }
    }
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
var SyncManager = class extends EventEmitter {
  constructor(peerId) {
    super();
    this.connected = false;
    this.peerId = peerId;
    this.vectorClock = new VectorClock(peerId);
    this.transport = new WebRTCTransport(peerId);
    this.transport.onMessage((data) => {
      this.handleRemoteData(data);
    });
  }
  connect(signalingUrl, roomId = "default-room") {
    this.transport.connect(signalingUrl, roomId);
    this.connected = true;
    this.emit("online");
  }
  disconnect() {
    this.transport.disconnect();
    this.connected = false;
    this.emit("offline");
  }
  broadcast(operation) {
    if (!this.connected) return;
    const encoder = new TextEncoder();
    const clockBytes = encoder.encode(JSON.stringify(this.vectorClock.getClock()));
    const typeBytes = encoder.encode(operation.type);
    const collectionBytes = encoder.encode(operation.collection);
    const docIdBytes = encoder.encode(operation.docId);
    const dataBytes = encoder.encode(JSON.stringify(operation));
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
    this.transport.send(buffer);
  }
  handleRemoteData(data) {
    if (typeof data === "string") return;
    const view = new DataView(data);
    let offset = 0;
    const decoder = new TextDecoder();
    const clockLen = view.getUint16(offset);
    offset += 2;
    const clockStr = decoder.decode(new Uint8Array(data, offset, clockLen));
    offset += clockLen;
    const typeLen = view.getUint8(offset);
    offset += 1;
    offset += typeLen;
    const collectionLen = view.getUint16(offset);
    offset += 2;
    offset += collectionLen;
    const docIdLen = view.getUint16(offset);
    offset += 2;
    offset += docIdLen;
    const dataLen = view.getUint32(offset);
    offset += 4;
    const dataStr = decoder.decode(new Uint8Array(data, offset, dataLen));
    offset += dataLen;
    try {
      const clock = JSON.parse(clockStr);
      const operation = JSON.parse(dataStr);
      this.vectorClock.update(clock);
      this.receive(operation);
    } catch (e) {
      console.error("Failed to parse remote operation", e);
    }
  }
  onRemoteOperation(callback) {
    this.on("sync", callback);
  }
  receive(operation) {
    this.vectorClock.update({ [operation.peerId]: operation.timestamp });
    this.emit("sync", operation);
  }
  getVectorClock() {
    return this.vectorClock;
  }
};

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
    this.collections = {};
    this.operations = [];
  }
  async get(collection, id) {
    return this.collections[collection]?.[id] || null;
  }
  async set(collection, id, data) {
    if (!this.collections[collection]) {
      this.collections[collection] = {};
    }
    this.collections[collection][id] = data;
  }
  async delete(collection, id) {
    if (this.collections[collection]) {
      delete this.collections[collection][id];
    }
  }
  async getAll(collection) {
    if (!this.collections[collection]) return [];
    return Object.values(this.collections[collection]);
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
  async importData(json) {
    try {
      const ops = JSON.parse(json);
      if (Array.isArray(ops)) {
        for (const op of ops) {
          this.syncManager.receive(op);
        }
      }
    } catch (e) {
      console.error("Failed to import data:", e);
    }
  }
};

// src/crdt/or-set.ts
var ORSet = class {
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
  merge(other) {
    for (const id of other.removed) {
      this.remove(id);
    }
    for (const [id, value] of other.added.entries()) {
      if (!this.removed.has(id)) {
        this.added.set(id, value);
      }
    }
  }
};
export {
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
};
//# sourceMappingURL=index.mjs.map