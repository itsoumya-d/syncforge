// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const {
  SyncForge, Collection, Query, SyncManager, VectorClock,
  LWWRegister, LWWMap, ORSet, GCounter, PNCounter,
  IndexedDBAdapter, MemoryAdapter, EventEmitter
} = await import(join(__dirname, '../dist/index.mjs'));

// ---------------------------------------------------------------------------
// Module shape
// ---------------------------------------------------------------------------
describe('Module exports', () => {
  test('all documented symbols are exported', () => {
    const mod = { SyncForge, Collection, Query, SyncManager, VectorClock,
      LWWRegister, LWWMap, ORSet, GCounter, PNCounter,
      IndexedDBAdapter, MemoryAdapter, EventEmitter };
    for (const name of Object.keys(mod)) {
      assert.ok(mod[name] !== undefined, `Missing export: ${name}`);
    }
  });
});

// ---------------------------------------------------------------------------
// EventEmitter
// ---------------------------------------------------------------------------
describe('EventEmitter', () => {
  test('on/emit basic', () => {
    const ee = new EventEmitter();
    let received = null;
    ee.on('test', (v) => { received = v; });
    ee.emit('test', 42);
    assert.equal(received, 42);
  });

  test('off removes listener', () => {
    const ee = new EventEmitter();
    let count = 0;
    const fn = () => count++;
    ee.on('x', fn);
    ee.emit('x');
    ee.off('x', fn);
    ee.emit('x');
    assert.equal(count, 1);
  });

  test('unknown event emits nothing (no throw)', () => {
    const ee = new EventEmitter();
    assert.doesNotThrow(() => ee.emit('nonexistent', 1, 2, 3));
  });
});

// ---------------------------------------------------------------------------
// VectorClock — actual API: constructor(peerId), increment(), getClock(),
//   getTimestamp(), update(remoteClock)
// ---------------------------------------------------------------------------
describe('VectorClock', () => {
  test('increment returns incrementing value', () => {
    const vc = new VectorClock('peerA');
    const t1 = vc.increment();
    const t2 = vc.increment();
    assert.equal(t1, 1);
    assert.equal(t2, 2);
  });

  test('getTimestamp returns local clock', () => {
    const vc = new VectorClock('peerA');
    vc.increment();
    assert.equal(vc.getTimestamp(), 1);
  });

  test('getClock returns clock map', () => {
    const vc = new VectorClock('peerA');
    vc.increment();
    const clock = vc.getClock();
    assert.equal(clock['peerA'], 1);
  });

  test('update merges remote clocks (takes max)', () => {
    const vc = new VectorClock('peerA');
    vc.increment(); // peerA=1
    vc.update({ peerB: 5, peerA: 3 }); // peerA stays 3 (max), peerB=5
    const clock = vc.getClock();
    assert.equal(clock['peerA'], 3);
    assert.equal(clock['peerB'], 5);
  });
});

// ---------------------------------------------------------------------------
// LWWRegister — actual API: .value (property), .set(value, ts, peerId)
// ---------------------------------------------------------------------------
describe('LWWRegister', () => {
  test('constructor sets initial value', () => {
    const r = new LWWRegister('hello', 1, 'peerA');
    assert.equal(r.value, 'hello');
  });

  test('set with higher timestamp wins', () => {
    const r = new LWWRegister('old', 1, 'peerA');
    r.set('new', 2, 'peerA');
    assert.equal(r.value, 'new');
  });

  test('set with lower timestamp is ignored', () => {
    const r = new LWWRegister('current', 5, 'peerA');
    r.set('stale', 3, 'peerB');
    assert.equal(r.value, 'current');
  });

  test('tie-break by peer ID lexicographic (Z > A)', () => {
    const r = new LWWRegister('a', 5, 'peerA');
    r.set('b', 5, 'peerZ');
    assert.equal(r.value, 'b');
  });

  test('merge applies remote register if newer', () => {
    const a = new LWWRegister('v1', 1, 'peerA');
    const b = new LWWRegister('v2', 2, 'peerB');
    a.merge(b);
    assert.equal(a.value, 'v2');
  });
});

// ---------------------------------------------------------------------------
// GCounter — actual API: .increment(peerId, amount), .value (getter), .merge(other)
// ---------------------------------------------------------------------------
describe('GCounter', () => {
  test('increment and value getter', () => {
    const c = new GCounter();
    c.increment('peerA', 3);
    c.increment('peerB', 7);
    assert.equal(c.value, 10);
  });

  test('negative increment throws', () => {
    const c = new GCounter();
    assert.throws(() => c.increment('peerA', -2), /positive/i);
  });

  test('merge keeps max per peer', () => {
    const a = new GCounter();
    a.increment('p1', 5); // p1=5
    const b = new GCounter();
    b.increment('p1', 3); // p1=3
    b.increment('p2', 4); // p2=4
    a.merge(b);
    assert.equal(a.value, 9); // max(5,3)=5 + 4 = 9
  });
});

// ---------------------------------------------------------------------------
// PNCounter — actual API: .increment(peerId, amt), .decrement(peerId, amt),
//   .value (getter), .merge(other)
// ---------------------------------------------------------------------------
describe('PNCounter', () => {
  test('increment and decrement', () => {
    const pn = new PNCounter();
    pn.increment('peerA', 10);
    pn.decrement('peerA', 3);
    assert.equal(pn.value, 7);
  });

  test('multiple peers converge', () => {
    const pn = new PNCounter();
    pn.increment('peerA', 5);
    pn.increment('peerB', 3);
    pn.decrement('peerC', 2);
    assert.equal(pn.value, 6);
  });
});

// ---------------------------------------------------------------------------
// ORSet — actual API: .add(id, value), .remove(id), .has(value),
//   .values (getter), .merge(other)
// ---------------------------------------------------------------------------
describe('ORSet', () => {
  test('add and has', () => {
    const s = new ORSet();
    s.add('tag1', 'apple');
    assert.ok(s.has('apple'));
  });

  test('remove by tag', () => {
    const s = new ORSet();
    s.add('tag1', 'apple');
    s.remove('tag1');
    assert.ok(!s.has('apple'));
  });

  test('re-add after remove creates new entry', () => {
    const s = new ORSet();
    s.add('tag1', 'apple');
    s.remove('tag1');
    s.add('tag2', 'apple'); // new unique tag
    assert.ok(s.has('apple'));
  });

  test('values getter returns array of current elements', () => {
    const s = new ORSet();
    s.add('t1', 'a');
    s.add('t2', 'b');
    const vals = s.values;
    assert.ok(Array.isArray(vals));
    assert.ok(vals.includes('a'));
    assert.ok(vals.includes('b'));
  });

  test('merge combines two ORSets', () => {
    const a = new ORSet();
    a.add('t1', 'x');
    const b = new ORSet();
    b.add('t2', 'y');
    a.merge(b);
    assert.ok(a.has('x'));
    assert.ok(a.has('y'));
  });
});

// ---------------------------------------------------------------------------
// LWWMap
// ---------------------------------------------------------------------------
describe('LWWMap', () => {
  test('set and get', () => {
    const m = new LWWMap();
    m.set('key', 'value', 1, 'peerA');
    assert.equal(m.get('key'), 'value');
  });

  test('concurrent set — higher timestamp wins', () => {
    const m = new LWWMap();
    m.set('k', 'old', 1, 'peerA');
    m.set('k', 'new', 5, 'peerB');
    assert.equal(m.get('k'), 'new');
  });

  test('get on missing key returns undefined or null', () => {
    const m = new LWWMap();
    const v = m.get('nonexistent');
    assert.ok(v === undefined || v === null);
  });
});

// ---------------------------------------------------------------------------
// MemoryAdapter — actual API: get(coll, id), set(coll, id, data), delete(coll, id),
//   getAll(coll), saveOperation(op), getOperations()
// ---------------------------------------------------------------------------
describe('MemoryAdapter', () => {
  test('set and get round-trip', async () => {
    const adapter = new MemoryAdapter();
    await adapter.set('col', 'k1', { x: 1 });
    const result = await adapter.get('col', 'k1');
    assert.deepEqual(result, { x: 1 });
  });

  test('get on missing key returns null', async () => {
    const adapter = new MemoryAdapter();
    const result = await adapter.get('col', 'missing');
    assert.ok(result === null || result === undefined);
  });

  test('delete removes entry', async () => {
    const adapter = new MemoryAdapter();
    await adapter.set('col', 'k', 42);
    await adapter.delete('col', 'k');
    const result = await adapter.get('col', 'k');
    assert.ok(result === null || result === undefined);
  });

  test('getAll returns all entries for collection', async () => {
    const adapter = new MemoryAdapter();
    await adapter.set('col', 'a', 1);
    await adapter.set('col', 'b', 2);
    const all = await adapter.getAll('col');
    assert.ok(Array.isArray(all));
    assert.ok(all.length >= 2);
  });

  test('saveOperation / getOperations round-trip', async () => {
    const adapter = new MemoryAdapter();
    const fakeOp = { type: 'set', collection: 'c', id: 'x', data: {}, timestamp: 1, peerId: 'p' };
    await adapter.saveOperation(fakeOp);
    const ops = await adapter.getOperations();
    assert.ok(ops.length >= 1);
  });
});

// ---------------------------------------------------------------------------
// SyncForge (MemoryAdapter-backed — no IndexedDB in Node)
// ---------------------------------------------------------------------------
describe('SyncForge', () => {
  function makeDb(name) {
    return new SyncForge({ dbName: name });
  }

  test('constructor with dbName produces instance', () => {
    assert.ok(makeDb('test-db'));
  });

  test('collection() returns a Collection', () => {
    const col = makeDb('col-db').collection('users');
    assert.ok(col);
  });

  test('set then get round-trip', async () => {
    const col = makeDb('rt-db').collection('things');
    await col.set('id1', { name: 'widget' });
    const doc = await col.get('id1');
    assert.equal(doc.name, 'widget');
  });

  test('get on non-existent id returns null', async () => {
    const col = makeDb('null-db').collection('empty');
    const doc = await col.get('no-such-id');
    assert.ok(doc === null || doc === undefined);
  });

  test('delete removes document', async () => {
    const col = makeDb('del-db').collection('stuff');
    await col.set('x', { v: 1 });
    await col.delete('x');
    const doc = await col.get('x');
    assert.ok(doc === null || doc === undefined);
  });

  test('getAll returns all documents', async () => {
    const col = makeDb('all-db').collection('items');
    await col.set('a', { n: 1 });
    await col.set('b', { n: 2 });
    const all = await col.getAll();
    assert.ok(Array.isArray(all));
    assert.ok(all.length >= 2);
  });

  test('double-init same dbName does not throw', () => {
    assert.doesNotThrow(() => { makeDb('dup-db'); makeDb('dup-db'); });
  });

  test('disconnect() does not throw', () => {
    assert.doesNotThrow(() => makeDb('disc-db').disconnect());
  });
});

// ---------------------------------------------------------------------------
// Collection queries and subscriptions
// ---------------------------------------------------------------------------
describe('Collection queries', () => {
  test('where/get filters correctly', async () => {
    const col = new SyncForge({ dbName: 'query-db' }).collection('products');
    await col.set('p1', { name: 'Foo', active: true });
    await col.set('p2', { name: 'Bar', active: false });
    await col.set('p3', { name: 'Baz', active: true });
    const active = await col.where('active', '==', true).get();
    assert.ok(active.every(d => d.active === true));
    assert.equal(active.length, 2);
  });

  test('limit constrains result count', async () => {
    const col = new SyncForge({ dbName: 'limit-db' }).collection('nums');
    for (let i = 0; i < 5; i++) await col.set('n' + i, { v: i });
    const res = await col.limit(2).get();
    assert.ok(res.length <= 2);
  });

  test('subscribe fires on change', async () => {
    const col = new SyncForge({ dbName: 'sub-db' }).collection('events');
    let fired = false;
    const unsub = col.subscribe(() => { fired = true; });
    await col.set('e1', { data: 'hello' });
    await new Promise(r => setTimeout(r, 50));
    unsub();
    assert.ok(fired, 'subscribe callback was not called');
  });
});

// ---------------------------------------------------------------------------
// Adversarial / edge cases
// ---------------------------------------------------------------------------
describe('Adversarial cases', () => {
  test('set with empty string id does not hang', async () => {
    const col = new SyncForge({ dbName: 'edge-db' }).collection('edge');
    try { await col.set('', { v: 1 }); } catch (e) {
      assert.ok(typeof e.message === 'string');
    }
  });

  test('set with null data does not corrupt store', async () => {
    const col = new SyncForge({ dbName: 'null-data-db' }).collection('nulls');
    try { await col.set('id', null); } catch {}
    await col.set('other', { ok: true });
    const doc = await col.get('other');
    assert.ok(doc);
  });

  test('exportData / importData round-trip', async () => {
    const db = new SyncForge({ dbName: 'export-db' });
    await db.collection('data').set('r1', { x: 99 });
    const json = await db.exportData();
    assert.ok(typeof json === 'string');
    const db2 = new SyncForge({ dbName: 'import-db' });
    await assert.doesNotReject(() => db2.importData(json));
  });

  test('GCounter throws on negative increment', () => {
    const c = new GCounter();
    assert.throws(() => c.increment('p', -1));
  });

  test('ORSet remove on unknown tag is no-op', () => {
    const s = new ORSet();
    assert.doesNotThrow(() => s.remove('nonexistent-tag'));
  });
});
