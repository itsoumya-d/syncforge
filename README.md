# SyncForge

A CRDT-powered, local-first real-time database that replaces Firebase Realtime DB and Supabase at $0 cost. Data lives on user devices and syncs peer-to-peer.

## Overview

SyncForge uses Conflict-Free Replicated Data Types (CRDTs) to ensure that concurrent updates from multiple users do not result in conflicts. It works 100% offline and syncs automatically when the device is reconnected.

### Comparison with Firebase

| Feature | Firebase | SyncForge |
|---------|----------|-----------|
| Architecture | Client-Server | Peer-to-Peer (Local-First) |
| Cost | Pay per read/write | $0 (Open Source) |
| Offline | Caching (can be flaky) | First-class citizen |
| Conflict Resolution | Last write wins | Deterministic CRDTs |

## Usage

```typescript
import { SyncForge } from 'syncforge';

const db = new SyncForge({ dbName: 'my-app', peerId: 'user-1' });

// Create a collection
const users = db.collection('users');

// Real-time subscription
users.subscribeDoc('alice', (doc) => {
  console.log('Alice updated:', doc);
});

// Write data (works offline)
await users.set('alice', { name: 'Alice', age: 30 });
```

## How CRDTs Work

SyncForge relies on Conflict-Free Replicated Data Types:
- **LWWRegister (Last-Writer-Wins):** For scalar fields.
- **GCounter (Grow-only):** For monotonically increasing values.
- **PNCounter (Positive-Negative):** For balances or counts that can go up and down.
- **ORSet (Observed-Remove):** For arrays and collections of items.
- **LWWMap:** For JSON documents and maps.

## License

SyncForge is licensed under the AGPL-3.0 License. See the LICENSE file for more information.
For commercial use, see COMMERCIAL_LICENSE.md.
