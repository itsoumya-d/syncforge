// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
//
// Property-based tests for the CRDT layer.
//
// A CRDT's merge must be a join on a lattice: commutative, associative and
// idempotent. If any of those fails, two replicas that saw the same operations
// in a different order can end up in different states forever. These are the
// only tests that can actually establish that, and they need no network — the
// merge algebra is pure.
//
// All randomness is seeded (mulberry32), so a failure prints a seed you can
// replay exactly.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { SyncForge, LWWRegister, LWWMap, ORSet, GCounter, PNCounter } =
  await import(join(__dirname, '../dist/index.mjs'));

// Keep the default low enough for CI; raise locally with ITER=5000.
const ITER = Number(process.env.ITER || 500);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Key-order-insensitive serialisation, so replica comparison is structural. */
function canon(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
}

const drain = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

const PEERS = ['p1', 'p2', 'p3'];
const KEYS = ['a', 'b', 'c'];

const state = {
  LWWRegister: (r) => canon([r.value, r.timestamp, r.peerId]),
  LWWMap: (m) =>
    canon([...m.data.entries()].map(([k, r]) => [k, r.value, r.timestamp, r.peerId]).sort((x, y) => (x[0] < y[0] ? -1 : 1))),
  GCounter: (c) => canon(Object.fromEntries(Object.entries(c.counts).sort())),
  PNCounter: (c) => canon([Object.fromEntries(Object.entries(c.positives.counts).sort()),
                           Object.fromEntries(Object.entries(c.negatives.counts).sort())]),
  ORSet: (s) => canon([[...s.added.entries()].sort(), [...s.removed].sort()]),
};

// Each builder returns a factory so every law gets a pristine copy of the state.
const build = {
  LWWRegister(r, now) {
    const ops = [];
    for (let i = 0, n = 1 + Math.floor(r() * 4); i < n; i++)
      ops.push([`v${Math.floor(r() * 5)}`, now - Math.floor(r() * 1000), PEERS[Math.floor(r() * 3)]]);
    return () => { const x = new LWWRegister(); for (const o of ops) x.set(...o); return x; };
  },
  LWWMap(r, now) {
    const ops = [];
    for (let i = 0, n = 1 + Math.floor(r() * 6); i < n; i++)
      ops.push([KEYS[Math.floor(r() * 3)], `v${Math.floor(r() * 5)}`, now - Math.floor(r() * 1000), PEERS[Math.floor(r() * 3)]]);
    return () => { const x = new LWWMap(); for (const o of ops) x.set(...o); return x; };
  },
  GCounter(r) {
    const ops = [];
    for (let i = 0, n = 1 + Math.floor(r() * 5); i < n; i++) ops.push([PEERS[Math.floor(r() * 3)], 1 + Math.floor(r() * 9)]);
    return () => { const x = new GCounter(); for (const o of ops) x.increment(...o); return x; };
  },
  PNCounter(r) {
    const ops = [];
    for (let i = 0, n = 1 + Math.floor(r() * 5); i < n; i++)
      ops.push([r() < 0.5 ? 'increment' : 'decrement', PEERS[Math.floor(r() * 3)], 1 + Math.floor(r() * 9)]);
    return () => { const x = new PNCounter(); for (const [m, p, a] of ops) x[m](p, a); return x; };
  },
  ORSet(r) {
    const ops = [];
    for (let i = 0, n = 1 + Math.floor(r() * 6); i < n; i++) {
      const id = `t${Math.floor(r() * 5)}`;
      ops.push(r() < 0.65 ? ['add', id, `e${Math.floor(r() * 4)}`] : ['remove', id]);
    }
    return () => {
      const x = new ORSet();
      for (const o of ops) (o[0] === 'add' ? x.add(o[1], o[2]) : x.remove(o[1]));
      return x;
    };
  },
};

// ---------------------------------------------------------------------------
// The three lattice laws, for every CRDT type
// ---------------------------------------------------------------------------
for (const type of Object.keys(build)) {
  describe(`${type} merge algebra (${ITER} seeded random states)`, () => {
    const eq = state[type];
    const now = Date.now();

    test('commutativity: merge(a,b) == merge(b,a)', () => {
      for (let seed = 1; seed <= ITER; seed++) {
        const r = rng(seed);
        const a = build[type](r, now), b = build[type](r, now);
        const ab = a(); ab.merge(b());
        const ba = b(); ba.merge(a());
        assert.equal(eq(ab), eq(ba),
          `not commutative at seed=${seed}\n  a=${eq(a())}\n  b=${eq(b())}\n  merge(a,b)=${eq(ab)}\n  merge(b,a)=${eq(ba)}`);
      }
    });

    test('associativity: (a∪b)∪c == a∪(b∪c)', () => {
      for (let seed = 1; seed <= ITER; seed++) {
        const r = rng(seed);
        const a = build[type](r, now), b = build[type](r, now), c = build[type](r, now);
        const left = a(); left.merge(b()); left.merge(c());
        const bc = b(); bc.merge(c());
        const right = a(); right.merge(bc);
        assert.equal(eq(left), eq(right), `not associative at seed=${seed}`);
      }
    });

    test('idempotence: merge(a,a) == a', () => {
      for (let seed = 1; seed <= ITER; seed++) {
        const r = rng(seed);
        const a = build[type](r, now);
        const aa = a(); aa.merge(a());
        assert.equal(eq(aa), eq(a()), `not idempotent at seed=${seed}`);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Regression tests for the specific counterexamples the fuzzer produced
// ---------------------------------------------------------------------------
describe('LWW tie-break is a total order', () => {
  test('equal timestamp AND equal peerId still converges', () => {
    const ts = 1000;
    const a = new LWWRegister('alpha', ts, 'p1');
    const b = new LWWRegister('beta', ts, 'p1');
    const ab = new LWWRegister('alpha', ts, 'p1'); ab.merge(b);
    const ba = new LWWRegister('beta', ts, 'p1'); ba.merge(a);
    assert.equal(ab.value, ba.value, 'same (timestamp, peerId) with different values must still converge');
  });

  test('Date.now()-stamped writes inside one millisecond converge', () => {
    // Date.now() has 1 ms granularity, so back-to-back writes tie.
    const build2 = () => {
      const m = new LWWMap();
      const ts = Date.now();
      for (let i = 0; i < 50; i++) m.set('title', 'v' + i, ts, 'peerA');
      return m;
    };
    assert.equal(build2().get('title'), build2().get('title'));
  });
});

describe('ORSet tag collisions converge', () => {
  test('same tag bound to two different values', () => {
    const A = new ORSet(); A.add('t1', 'apple');
    const B = new ORSet(); B.add('t1', 'banana');
    const ab = new ORSet(); ab.add('t1', 'apple'); ab.merge(B);
    const ba = new ORSet(); ba.add('t1', 'banana'); ba.merge(A);
    assert.deepEqual(ab.values, ba.values);
  });
});

describe('LWWMap.merge does not lose keys', () => {
  test('merging a large map into a small one keeps every key', () => {
    const ts = Date.now();
    const big = new LWWMap();
    for (let i = 0; i < 500; i++) big.set('b' + i, i, ts, 'p1');
    const target = new LWWMap();
    target.set('own', 1, ts, 'p2');
    target.merge(big);
    assert.equal(target.data.size, 501);
    assert.equal(target.get('own'), 1);
  });
});

// ---------------------------------------------------------------------------
// End-to-end convergence through Collection + SyncManager
// ---------------------------------------------------------------------------
async function converge(seed, { peers: nPeers, ops: nOps, docs, duplicate = false }) {
  const r = rng(seed);
  const replicas = [];
  for (let i = 0; i < nPeers; i++) {
    const db = new SyncForge({ dbName: `conv-${seed}-${i}`, peerId: `p${i}` });
    replicas.push({ db, col: db.collection('docs'), origin: new Set() });
  }

  const log = [];
  for (let k = 0; k < nOps; k++) {
    const p = replicas[Math.floor(r() * nPeers)];
    const doc = docs[Math.floor(r() * docs.length)];
    const before = JSON.parse(await p.db.exportData()).length;
    const dice = r();
    if (dice < 0.5) await p.col.set(doc, { [['x', 'y', 'z'][Math.floor(r() * 3)]]: `v${Math.floor(r() * 4)}` });
    else if (dice < 0.62) await p.col.delete(doc);
    else if (dice < 0.81) await p.col.increment(doc, 'n', 1 + Math.floor(r() * 3));
    else await p.col.decrement(doc, 'n', 1 + Math.floor(r() * 3));
    await drain();
    const ops = JSON.parse(await p.db.exportData());
    if (ops.length > before) { const op = ops[ops.length - 1]; log.push(op); p.origin.add(op.id); }
  }

  // Every replica receives every foreign op, in its own random order.
  for (const p of replicas) {
    let stream = log.filter((o) => !p.origin.has(o.id));
    for (let i = stream.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [stream[i], stream[j]] = [stream[j], stream[i]];
    }
    if (duplicate) {
      const dup = [];
      for (const o of stream) { dup.push(o); if (r() < 0.3) dup.push(o); }
      stream = dup;
    }
    for (const op of stream) { p.db.syncManager.receive(op); await drain(); }
  }

  const states = [];
  for (const p of replicas) {
    const out = {};
    for (const d of docs) out[d] = await p.col.get(d);
    states.push(canon(out));
  }
  return states;
}

describe('replica convergence (randomised delivery order)', () => {
  const trials = Number(process.env.CONV_ITER || 40);

  test('3 replicas converge regardless of delivery order', async () => {
    for (let seed = 1; seed <= trials; seed++) {
      const s = await converge(seed, { peers: 3, ops: 8, docs: ['d1', 'd2'] });
      assert.ok(s.every((x) => x === s[0]), `divergence at seed=${seed}\n${s.map((x, i) => `  p${i}: ${x}`).join('\n')}`);
    }
  });

  test('5 replicas / 30 ops converge regardless of delivery order', async () => {
    for (let seed = 1; seed <= trials; seed++) {
      const s = await converge(seed, { peers: 5, ops: 30, docs: ['d1', 'd2', 'd3'] });
      assert.ok(s.every((x) => x === s[0]), `divergence at seed=${seed}\n${s.map((x, i) => `  p${i}: ${x}`).join('\n')}`);
    }
  });

  test('converge under at-least-once (duplicate) delivery', async () => {
    for (let seed = 1; seed <= trials; seed++) {
      const s = await converge(seed, { peers: 5, ops: 30, docs: ['d1', 'd2', 'd3'], duplicate: true });
      assert.ok(s.every((x) => x === s[0]), `divergence at seed=${seed}\n${s.map((x, i) => `  p${i}: ${x}`).join('\n')}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Operation-application invariants
// ---------------------------------------------------------------------------
describe('operation application', () => {
  test('duplicate delivery of an inc op does not double-count', async () => {
    const a = new SyncForge({ dbName: 'dup-a', peerId: 'pA' });
    await a.collection('c').increment('d', 'n', 5);
    await drain();
    const op = JSON.parse(await a.exportData())[0];

    const b = new SyncForge({ dbName: 'dup-b', peerId: 'pB' });
    const cb = b.collection('c');
    for (let i = 0; i < 4; i++) { b.syncManager.receive(op); await drain(); }
    assert.equal((await cb.get('d')).n, 5);
  });

  test('importData is idempotent', async () => {
    const db = new SyncForge({ dbName: 'imp' });
    const c = db.collection('c');
    await c.increment('d', 'hits', 1);
    await c.increment('d', 'hits', 1);
    await drain();
    const snapshot = await db.exportData();
    await db.importData(snapshot);
    await db.importData(snapshot);
    await drain();
    assert.equal((await c.get('d')).hits, 2);
  });

  test('a deleted document can be re-created', async () => {
    const c = new SyncForge({ dbName: 'resurrect' }).collection('c');
    await c.set('u', { name: 'alice' }); await drain();
    await c.delete('u'); await drain();
    assert.equal(await c.get('u'), null);
    await c.set('u', { name: 'bob' }); await drain();
    assert.deepEqual(await c.get('u'), { name: 'bob' }, 'delete must not be permanent');
  });

  test('internal _deleted marker never leaks into a document', async () => {
    const c = new SyncForge({ dbName: 'leak' }).collection('c');
    await c.set('u', { name: 'alice' }); await drain();
    await c.delete('u'); await drain();
    await c.set('u', { name: 'bob' }); await drain();
    assert.deepEqual(Object.keys(await c.get('u')), ['name']);
  });

  test("a replica's own write is never discarded by a remote timestamp", async () => {
    const a = new SyncForge({ dbName: 'lam-a', peerId: 'pA' });
    const ca = a.collection('c');
    for (let i = 0; i < 5; i++) await ca.set('doc', { title: 'A' + i });
    await drain();
    const ops = JSON.parse(await a.exportData());

    const b = new SyncForge({ dbName: 'lam-b', peerId: 'pB' });
    const cb = b.collection('c');
    b.syncManager.receive(ops[ops.length - 1]);
    await drain();
    await cb.set('doc', { title: 'MINE' });
    await drain();
    assert.equal((await cb.get('doc')).title, 'MINE', 'a local write must always be visible locally');
  });

  test('concurrent operations on one document do not lose updates', async () => {
    const c = new SyncForge({ dbName: 'race-1' }).collection('c');
    await Promise.all([
      c.set('d', { a: 1 }), c.set('d', { b: 2 }), c.set('d', { e: 3 }),
      c.set('d', { f: 4 }), c.set('d', { g: 5 }),
    ]);
    await drain();
    assert.deepEqual(await c.get('d'), { a: 1, b: 2, e: 3, f: 4, g: 5 });

    const c2 = new SyncForge({ dbName: 'race-2' }).collection('c');
    await Promise.all(Array.from({ length: 10 }, () => c2.increment('d', 'n', 1)));
    await drain();
    assert.equal((await c2.get('d')).n, 10);
  });
});

// ---------------------------------------------------------------------------
// Input validation / hostile input
// ---------------------------------------------------------------------------
describe('input validation', () => {
  test('constructor rejects malformed options with a clear error', () => {
    for (const bad of [undefined, null, 'name', 42, [], {}]) {
      assert.throws(() => new SyncForge(bad), /SyncForge: options/);
    }
    assert.ok(new SyncForge({ dbName: 'ok' }));
  });

  test('non-serialisable values are rejected before anything is written', async () => {
    const db = new SyncForge({ dbName: 'circ' });
    const c = db.collection('c');
    await c.set('good', { v: 1 });
    const circular = { a: 1 };
    circular.self = circular;
    await assert.rejects(() => c.set('bad', circular), /not JSON-serialisable/);
    assert.equal(await c.get('bad'), null);
    // The operation log must remain exportable.
    assert.ok((await db.exportData()).length > 0);
  });

  test('a collection named __proto__ does not pollute Object.prototype', async () => {
    const db = new SyncForge({ dbName: 'proto' });
    await db.collection('__proto__').set('k', { p: 1 });
    await drain();
    assert.equal({}.p, undefined);
    assert.ok(!Object.getOwnPropertyNames(Object.prototype).includes('k'));
  });

  test('a throwing change listener neither breaks set() nor starves other listeners', async () => {
    const c = new SyncForge({ dbName: 'listener' }).collection('c');
    const ran = [];
    c.on('change', () => { throw new Error('user callback blew up'); });
    c.on('change', () => ran.push(1));
    await c.set('d', { v: 1 });
    await drain();
    assert.ok(ran.length >= 1);
    assert.deepEqual(await c.get('d'), { v: 1 });
  });

  test('malformed inbound frames are dropped, not thrown', () => {
    const db = new SyncForge({ dbName: 'frames', peerId: 'pA' });
    const sm = db.syncManager;
    const frames = [
      new ArrayBuffer(0),
      new ArrayBuffer(1),
      new Uint8Array(16).fill(0xff).buffer,
      (() => { const b = new ArrayBuffer(16); new DataView(b).setUint16(0, 0xffff); return b; })(),
    ];
    for (const f of frames) assert.doesNotThrow(() => sm.handleRemoteData(f));
  });
});
