# Under the Hood of SyncForge: High-Throughput CRDT State Synchronization Over WebRTC DataChannels

SyncForge is fundamentally rethinking how modern web applications manage state. By moving computation and storage to the edge—literally into the user's browser—we bypass the latency and costs associated with centralized cloud databases. This deep dive explores the engineering architecture behind SyncForge, focusing on Conflict-Free Replicated Data Types (CRDTs) and peer-to-peer synchronization via WebRTC.

## The Problem with Centralized State

Traditional real-time databases (like Firebase Realtime DB or Supabase) rely on a central server to mediate state changes. When Client A and Client B modify the same document, the server resolves the conflict, usually by timestamp (last-write-wins) or by rejecting one of the writes.

This architecture has three fatal flaws:
1. **Latency**: Every operation requires a round-trip to the server.
2. **Offline Degradation**: If a user goes offline, they either can't write, or their writes are queued and blindly applied when they reconnect, often overwriting others' data.
3. **Cost**: You pay for every read, write, and megabyte of bandwidth, so cost scales with traffic rather than with the number of users' devices. (Figures vary by provider and plan; check current pricing rather than trusting a number in a blog post.)

## Enter CRDTs (Conflict-Free Replicated Data Types)

SyncForge uses CRDTs to ensure that all replicas (clients) can update their state independently and concurrently, without coordination, and mathematically guarantee that they will converge to the exact same state once all updates are exchanged.

### LWWMap (Last-Write-Wins Map)
For standard key-value objects, SyncForge utilizes an LWWMap. Every key in the map is associated with a timestamp (specifically, a Logical Clock) and a replica ID. When merging two LWW Maps, SyncForge compares the timestamps for each key. The value with the higher timestamp wins. If timestamps are identical, the replica ID breaks the tie.

### PNCounter (Positive-Negative Counter)
Standard integers can't use LWW if they are incremented concurrently (e.g., likes on a post). Instead, SyncForge uses a PNCounter. It maintains two state vectors internally: one for increments (P) and one for decrements (N). The actual value is the sum of all P values minus the sum of all N values across all replicas.

## Vector Clocks & Causal Ordering

To track causality and ensure updates are applied in the correct order, SyncForge employs Vector Clocks. A vector clock is an array of logical counters, one for each node in the network. 

```json
{
  "clientA": 15,
  "clientB": 8,
  "clientC": 42
}
```

When a client receives an operation it folds the attached clock into its own with a per-entry maximum, and stamps its next local write above everything it has seen (the Lamport send rule) so a write can never carry a timestamp below an operation it happens-after. Operations are not gated on causality — every operation is applied and the CRDT merge rules reconcile concurrent edits. Duplicates are suppressed by operation id, which matters because `inc`/`dec` are not idempotent.

## Wire Format

Each operation is framed as a length-prefixed binary envelope: the sender's vector clock, then the operation type, collection and document id as separate fields, then the operation itself as JSON.

Two honest caveats about this format:

- **It sends whole operations, not state deltas.** `LWWMap` does expose `delta(sinceTimestamp)`, `toBuffer()` and `fromBuffer()`, but nothing in the sync path calls them today — they are available for callers to build their own delta exchange on top.
- **The envelope is currently larger than the JSON it wraps.** Type, collection and document id are written into the header *and* repeated inside the JSON body, and the receiver discards the header copies. For a small document (36-byte payload, 154-byte operation) the frame measures 190 bytes — about 23% overhead. Deduplicating those fields is a straightforward improvement that has not been made yet.

## WebRTC Signaling & Reconnection

SyncForge leverages WebRTC DataChannels for peer-to-peer data transfer, bypassing the need for a relay server. 

However, WebRTC requires a signaling mechanism to establish the initial connection (exchanging SDP offers/answers). SyncForge speaks a small JSON protocol over a WebSocket for this — `join`, `peer-joined`, `offer`, `answer`, `ice-candidate`, `peer-left`, with a `target` field for routing. **You must run that server yourself; SyncForge does not ship one.** Once the peer connection is established the signaling server drops out of the data path.

**There is no outbox, and no anti-entropy on reconnect.** Operations written while no peer channel is open are persisted locally but are *not* queued for later transmission, and reconnecting peers do not compare vector clocks to discover what they missed. `broadcast()` returns the number of peers a frame actually reached, so a caller can detect `0` and arrange its own backfill with `exportData()` / `importData()`, but SyncForge will not do it for you. A dropped operation stays dropped.

Note also that without a TURN relay, ICE will reach `failed` for peers behind symmetric or carrier-grade NAT. That is now observable: subscribe to `peer-unreachable`, `ice-state`, `signaling-failed` and `error` on the database instance.

## Benchmark & Cost Analysis

| Metric | Firebase Firestore | Supabase Realtime | SyncForge |
|--------|--------------------|-------------------|-----------|
| **Architecture** | Centralized | Centralized | Peer-to-Peer |
| **Write Latency** | network round trip | network round trip | local write, no round trip |
| **Offline Writes** | Queued, high conflict risk | Requires custom handling | **Native CRDT Merge** |
| **Cost (10M Ops/mo)** | pay per op/GB | pay per op/GB | signaling + TURN only |
| **Transport** | WebSockets / HTTP | WebSockets | WebRTC DataChannels |

## Integration Guide for AI Agents

For AI coding assistants (like Copilot, Claude, or Cursor) building applications, here is the real, executable integration recipe.

**Two things to get right first.** SyncForge is **not** published to npm — the name `syncforge` on the registry belongs to an unrelated package by a different author, so `npm install syncforge` installs the wrong library. Import from the jsDelivr CDN or build from a clone. And the API is a flat set of named exports; there is no `SyncForge.Document`, no `SyncForge.WebRTCProvider`, and no `SyncForge.PNCounter` namespace member. Earlier revisions of this article showed those; they never existed and would throw `TypeError: ... is not a constructor`.

```typescript
import { SyncForge } from 'https://cdn.jsdelivr.net/gh/itsoumya-d/syncforge@main/dist/index.mjs';

// 1. Open a local-first database. dbName is required.
const db = new SyncForge({ dbName: 'shared-workspace-1' });

// 2. Work with collections of documents.
const tasks = db.collection('tasks');

await tasks.set('task-1', { title: 'Write tests', done: false });
const task = await tasks.get('task-1');          // { title: 'Write tests', done: false }

await tasks.increment('task-1', 'views', 1);      // PNCounter-backed field
const open = await tasks.where('done', '==', false).orderBy('title').limit(10).get();

// 3. Subscribe to changes.
const unsubscribe = tasks.subscribe((docs) => renderUI(docs));
const unsubscribeDoc = tasks.subscribeDoc('task-1', (doc) => renderOne(doc));

// 4. Join a peer mesh. You must supply your own signaling server.
db.on('online', () => console.log('a peer data channel is open'));
db.on('offline', () => console.log('no peers left'));
db.on('peer-unreachable', (info) => console.warn('ICE failed', info));
db.on('signaling-failed', (info) => console.error('signaling unreachable', info));
db.on('error', (err) => console.error(err));
db.connectPeer('wss://your-signaling-server.example');

console.log(db.isOnline()); // false until a peer channel actually opens
```

The CRDT primitives are also exported directly for standalone use: `LWWRegister`, `LWWMap`, `ORSet`, `GCounter`, `PNCounter`, `VectorClock`, plus `MemoryAdapter` and `IndexedDBAdapter`.

Keeping computation local removes the round trip on every read and write, and the CRDT merge rules mean concurrent edits reconcile without a coordinator. What it does not remove is the signaling server, a TURN relay if your users sit behind symmetric NAT, or the need to design for the fact that a lost operation is not automatically recovered.
