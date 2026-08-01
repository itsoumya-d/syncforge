<!--
// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1661@gmail.com | +91 7031648617
-->

# SyncForge

**The Local-First, Peer-to-Peer CRDT Database for the Modern Web**

[![License: BSL 1.1](https://img.shields.io/badge/License-BSL_1.1-red.svg)](https://mariadb.com/bsl11/)
[![Status: Pre-Release](https://img.shields.io/badge/status-pre--release-orange.svg)]()
[![Build](https://img.shields.io/badge/build-passing-brightgreen.svg)]()

---

> **WARNING — npm name collision.** The package name `syncforge` on the npm registry is owned by an unrelated author (`codewithcobby`). Running `npm install syncforge` installs their package, not this one. This is a silent failure — your project will compile against the wrong library. A rename of this project is pending the author's decision. **Do not use `npm install syncforge`.**

---

SyncForge is a CRDT-powered, local-first database library for real-time peer-to-peer synchronisation. It writes to local storage instantly and propagates changes to connected peers over WebRTC DataChannels in the background.

## Table of Contents
1. [Installation](#installation)
2. [Quick Start](#quick-start)
3. [Architecture](#architecture)
4. [API Reference](#api-reference)
5. [CRDT Types](#crdt-types-explained)
6. [Storage Adapters](#storage-adapters)
7. [Performance Benchmarks](#performance-benchmarks)
8. [Comparison Table](#comparison-table)
9. [Security Model](#security-model)
10. [Known Limitations](#known-limitations)
11. [FAQ](#faq)
12. [Author & License](#author--license)

---

## Installation

This library is **not published to npm**. Use one of these two paths:

### Option A — jsDelivr CDN (browser, no build step)

```html
<script type="module">
  import { SyncForge } from 'https://cdn.jsdelivr.net/gh/itsoumya-d/syncforge@main/dist/index.mjs';
</script>
```

### Option B — Clone and build

```bash
git clone https://github.com/itsoumya-d/syncforge.git
cd syncforge
npm install
npm run build
# dist/ is now available locally
```

---

## Quick Start

```typescript
import { SyncForge } from 'https://cdn.jsdelivr.net/gh/itsoumya-d/syncforge@main/dist/index.mjs';

// Initialize
const db = new SyncForge({ dbName: 'my-app-db' });

// Get a collection
const users = db.collection('users');

// Listen for connection events
db.on('online', () => console.log('Connected to peers'));

// Connect to P2P signaling server
db.connectPeer('wss://signaling.example.com');
```

---

## Architecture

SyncForge employs a local-first architecture. It writes to local storage first, then emits vector-clocked operations to connected peers.

```mermaid
graph TD
    A[Client App] -->|Reads/Writes| B(SyncForge Local DB)
    B -->|Persists| C[(IndexedDB / Memory)]
    B -->|Broadcasts Operations| D{SyncManager WebRTC}
    D <-->|P2P Sync| E[Peer Node 1]
    D <-->|P2P Sync| F[Peer Node 2]
    D <-->|P2P Sync| G[Peer Node N]
```

- **Local-First:** All CRUD operations hit the local storage adapter instantly.
- **SyncManager:** Listens for local changes and queues them for broadcast.
- **CRDT Resolution:** When a remote operation arrives, CRDT properties guarantee all peers converge on the same state regardless of delivery order.

---

## Usage Examples

### 1. Create DB & Add Documents
```typescript
const db = new SyncForge({ dbName: 'todo-db' });
const todos = db.collection('todos');

await todos.set('todo-1', { title: 'Buy milk', completed: false });
await todos.set('todo-2', { title: 'Read book', completed: true });
```

### 2. Querying Documents
```typescript
const pendingTodos = await todos
  .where('completed', '==', false)
  .orderBy('title', 'asc')
  .limit(10)
  .get();
```

### 3. Real-Time Subscriptions
```typescript
const unsubscribe = todos.subscribe((data) => {
  console.log('Collection updated:', data);
});

const unsubDoc = todos.subscribeDoc('todo-1', (doc) => {
  console.log('Todo 1 changed:', doc);
});
```

### 4. Offline Sync & P2P
```typescript
// Writes are stored in IndexedDB while offline.
await todos.set('todo-3', { title: 'Write code' });

// Connect to a peer network.
// SyncForge propagates offline changes automatically when reconnected.
db.connectPeer('wss://signaling.yourserver.com');
```

---

## API Reference

### `SyncForge`

- `constructor(options: { dbName: string; peerId?: string })` — initialises the database. If `peerId` is omitted, one is randomly generated.
- `collection(name: string): Collection` — returns a Collection instance.
- `connectPeer(signalingUrl: string): void` — connects to a signaling server to establish WebRTC connections.
- `disconnect(): void` — disconnects from all peers.
- `exportData(): Promise<string>` — exports all stored operations as a JSON string.
- `importData(json: string): Promise<void>` — imports data and applies it locally.

### `Collection`

- `set(id: string, data: object): Promise<void>`
- `get(id: string): Promise<Document | null>`
- `delete(id: string): Promise<void>`
- `getAll(): Promise<Document[]>`
- `where(field: string, op: Operator, value: any): Query`
- `orderBy(field: string, direction: 'asc'|'desc'): Query`
- `limit(n: number): Query`
- `increment(id: string, field: string, amount?: number): Promise<void>`
- `decrement(id: string, field: string, amount?: number): Promise<void>`
- `subscribe(callback: (docs: Document[]) => void): () => void`
- `subscribeDoc(id: string, callback: (doc: Document|null) => void): () => void`

### `Query`

- `where(field, op, value): Query`
- `orderBy(field, direction): Query`
- `limit(n): Query`
- `get(): Promise<Document[]>`
- `subscribe(callback): () => void`

---

## CRDT Types Explained

All CRDT types are exported and usable directly:

### `LWWRegister` (Last-Writer-Wins Register)
Stores a single value. Accesses the value via `.value` (property). Resolves conflicts by timestamp, then by peer ID.
```typescript
import { LWWRegister } from '...'; // from dist/index.mjs
const reg = new LWWRegister('initial', 1, 'peerA');
reg.set('updated', 2, 'peerB');
console.log(reg.value); // 'updated'
```

### `GCounter` (Grow-Only Counter)
Value accessed via `.value` getter (not `.value()`). Throws on negative increment.
```typescript
import { GCounter } from '...';
const counter = new GCounter();
counter.increment('peerA', 5);
console.log(counter.value); // 5
```

### `PNCounter` (Positive-Negative Counter)
Value accessed via `.value` getter.
```typescript
import { PNCounter } from '...';
const pn = new PNCounter();
pn.increment('peerA', 10);
pn.decrement('peerA', 3);
console.log(pn.value); // 7
```

### `ORSet` (Observed-Remove Set)
Elements accessed via `.values` getter (not `.values()`).
```typescript
import { ORSet } from '...';
const set = new ORSet();
set.add('id1', 'apple');
console.log(set.values); // ['apple']
set.remove('id1');
```

### `VectorClock`
Requires a `peerId` argument in the constructor. Uses `.increment()`, `.getClock()`, `.getTimestamp()`, `.update(remoteClock)`.
```typescript
import { VectorClock } from '...';
const vc = new VectorClock('peerA');
vc.increment();
console.log(vc.getTimestamp()); // 1
```

### `LWWMap` (Last-Writer-Wins Map)
A key-value map where each value is an `LWWRegister`.
```typescript
import { LWWMap } from '...';
const map = new LWWMap();
map.set('title', 'Hello', Date.now(), 'peerA');
console.log(map.get('title')); // 'Hello'
```

---

## Storage Adapters

1. **`IndexedDBAdapter`** — browser default. Data persists across page reloads.
2. **`MemoryAdapter`** — Node.js and testing. Ephemeral; data is lost on process exit. API: `get(collection, id)`, `set(collection, id, data)`, `delete(collection, id)`, `getAll(collection)`.

Both implement a common `StorageAdapter` interface.

---

## Performance Benchmarks

Measured on Node 24, Intel Xeon 2.90 GHz (2 cores), using `MemoryAdapter`:

| Operation | 1000 iterations | Per-op average |
|---|---|---|
| `col.set()` | 22 ms | 0.022 ms |
| `col.get()` | 2 ms | 0.002 ms |

The README previously claimed "~1ms read, ~2ms write". Reads are actually faster (~0.002 ms each in the MemoryAdapter). These numbers are memory-only; IndexedDB writes in the browser will be slower. P2P sync latency is network-dependent and not measured here.

---

## Comparison Table

| Feature | SyncForge | Firebase | Supabase | MongoDB | RxDB |
|---|---|---|---|---|---|
| **Architecture** | P2P Local-First | Cloud-First | Cloud-First | Cloud-First | Local-First |
| **Cost** | **$0 infra** | High (Usage) | Medium | High | Free (Premium plugins) |
| **Offline Support** | Full | Partial | Partial | None | Full |
| **Sync Mechanism** | WebRTC CRDTs | Centralized | Centralized | Centralized | CouchDB / GraphQL |
| **Conflict Res** | Auto (CRDT) | Last-Write | Last-Write | Last-Write | Custom |

---

## Security Model

- **E2E Encryption:** SyncForge does not encrypt data at rest or in transit. For sensitive data, encrypt payloads before calling `.set()`.
- **Signaling Server:** The WebRTC signaling server only brokers connections; it does not see database contents.
- **Validation:** Peers should validate incoming operations to prevent injection of unauthorised timestamps.

---

## Known Limitations

- **Pre-release status.** Not on npm. No production adopters. API may change.
- **No npm publication.** Running `npm install syncforge` installs an unrelated library. See Installation above.
- **No TURN relay — connections fail behind symmetric or carrier-grade NAT.** The ICE configuration uses a single public STUN server (`stun:stun.l.google.com:19302`). STUN cannot traverse symmetric NAT (common on corporate networks) or many mobile carrier-grade NAT deployments. When ICE fails, the peer is reported as disconnected via the `peer-disconnected` event — there is no distinct "unreachable network" error. Callers cannot distinguish "NAT failure" from "peer left voluntarily". If you need reliable connectivity across arbitrary networks, configure your own TURN server.
- **Browser-only IndexedDB.** Node.js uses `MemoryAdapter` which is ephemeral.
- **No authentication.** Any peer knowing your signaling room ID can join.
- **Large binary files.** SyncForge is optimised for JSON documents. Store large blobs elsewhere and sync their URLs.

---

## FAQ

**Q: Do I need a backend?**
A: You need a WebRTC signaling server to broker initial peer connections. No database backend is required.

**Q: What happens if all peers go offline?**
A: Data stays safely in the browser's IndexedDB. When a peer reconnects, it exchanges operations and converges.

**Q: Does it support large binary files?**
A: Not directly. Store them in IPFS or S3 and sync the URL via SyncForge.

---

## Author & License

**Author:** Soumya Debnath  
**Email:** soumyadebnath1661@gmail.com  
**GitHub:** [github.com/itsoumya-d](https://github.com/itsoumya-d)

---

## License — Business Source License 1.1

> **Source-available, NOT open-source. All production use requires a paid license.**

| Tier | Price | For |
|:-----|:------|:----|
| **Indie** | $399/year | Solo developer, <$100K revenue |
| **Startup** | $2,999/year | Up to 10-25 devs, <$5M revenue |
| **Enterprise** | $14,999/year | Unlimited seats, unlimited revenue |
| **OEM / White-Label** | $29,999/year | Embed in your product |
| **Full IP Buyout** | $1,500,000 | Complete ownership transfer |

**Free use limited to:** Personal evaluation, academic research, contributing via PRs.

[soumyadebnath1661@gmail.com](mailto:soumyadebnath1661@gmail.com) · [github.com/itsoumya-d](https://github.com/itsoumya-d)

© 2024-2026 Soumya Debnath. All Rights Reserved.
