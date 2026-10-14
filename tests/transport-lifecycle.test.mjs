import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SyncManager } from '../dist/index.mjs';

function fixture(t) {
  const sockets = [], peers = [], timers = new Map();
  const waits = { offer: Promise.resolve({ type: 'offer' }), remote: Promise.resolve() };
  let nextTimer = 1;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  const originalPeer = Object.getOwnPropertyDescriptor(globalThis, 'RTCPeerConnection');
  class Peer {
    constructor() { this.localDescriptions = []; this.answers = 0; peers.push(this); }
    createDataChannel() { return this.channel = { readyState: 'connecting' }; }
    createOffer() { return waits.offer; }
    setLocalDescription(value) { this.localDescriptions.push(value); return Promise.resolve(); }
    setRemoteDescription() { return waits.remote; }
    createAnswer() { this.answers++; return Promise.resolve({ type: 'answer' }); }
    close() { this.closed = true; }
  }
  class Socket {
    constructor(url) { this.url = url; this.sent = []; this.closed = false; sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.closed = true; this.onclose?.(); }
    open() { this.onopen?.(); }
  }
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: Socket });
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, writable: true, value: Peer });
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const id = nextTimer++; timers.set(id, { callback, delay }); return id;
  });
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  const manager = new SyncManager('local');
  t.after(() => {
    manager.disconnect();
    if (original) Object.defineProperty(globalThis, 'WebSocket', original);
    else delete globalThis.WebSocket;
    if (originalPeer) Object.defineProperty(globalThis, 'RTCPeerConnection', originalPeer);
    else delete globalThis.RTCPeerConnection;
  });
  return { manager, sockets, peers, waits, timers, runNext() {
    const [id, timer] = timers.entries().next().value;
    timers.delete(id); timer.callback(); return timer.delay;
  } };
}

test('intentional disconnect closes signaling without reconnecting', t => {
  const f = fixture(t); f.manager.connect('wss://one', 'room');
  f.sockets[0].open(); f.manager.disconnect();
  assert.equal(f.sockets[0].closed, true); assert.equal(f.timers.size, 0);
  assert.equal(f.manager.isConnected(), false);
});

test('disconnect cancels pending backoff and invalidates an already queued callback', t => {
  const f = fixture(t); f.manager.connect('wss://one'); f.sockets[0].close();
  assert.equal(f.timers.size, 1);
  const queued = [...f.timers.values()][0].callback;
  f.manager.disconnect(); assert.equal(f.timers.size, 0);
  queued(); assert.equal(f.sockets.length, 1);
});

test('explicit connect replaces the old socket and ignores its stale events', async t => {
  const f = fixture(t); f.manager.connect('wss://one', 'old');
  const old = f.sockets[0]; const { onopen, onclose, onerror, onmessage } = old;
  const errors = []; f.manager.on('error', e => errors.push(e));
  f.manager.connect('wss://two', 'new'); assert.equal(old.closed, true);
  onopen(); onclose(); onerror({}); await onmessage({ data: '{"type":"peer-joined","peerId":"stale"}' });
  assert.equal(f.timers.size, 0); assert.equal(errors.length, 0);
  assert.deepEqual(f.sockets[1].sent, []);
  f.sockets[1].open();
  assert.deepEqual(f.sockets[1].sent, [{ type: 'join', roomId: 'new', peerId: 'local' }]);
});

test('unexpected close retains bounded exponential retry and exhaustion notification', t => {
  const f = fixture(t), failed = []; f.manager.on('signaling-failed', e => failed.push(e));
  f.manager.connect('wss://one');
  for (const delay of [1000, 2000, 4000, 8000, 16000]) {
    f.sockets.at(-1).close(); assert.equal(f.timers.size, 1); assert.equal(f.runNext(), delay);
  }
  f.sockets.at(-1).close();
  assert.equal(f.timers.size, 0); assert.equal(failed.length, 1); assert.equal(failed[0].attempts, 5);
});

test('explicit connect gets a fresh retry budget after exhaustion', t => {
  const f = fixture(t); f.manager.connect('wss://one');
  for (let i = 0; i < 5; i++) { f.sockets.at(-1).close(); f.runNext(); }
  f.sockets.at(-1).close(); f.manager.connect('wss://two'); f.sockets.at(-1).close();
  assert.equal(f.timers.size, 1); assert.equal(f.runNext(), 1000);
});

test('duplicate close callbacks schedule at most one retry', t => {
  const f = fixture(t); f.manager.connect('wss://one'); const close = f.sockets[0].onclose;
  close(); close(); assert.equal(f.timers.size, 1);
});

test('old retry cannot replace a new session or consume its pending retry', t => {
  const f = fixture(t); f.manager.connect('wss://one'); f.sockets[0].close();
  const oldRetry = [...f.timers.values()][0].callback;
  f.manager.connect('wss://two'); f.sockets.at(-1).close();
  oldRetry(); assert.equal(f.sockets.length, 2); assert.equal(f.timers.size, 1);
  f.runNext(); assert.equal(f.sockets.length, 3); assert.equal(f.sockets.at(-1).url, 'wss://two');
});

test('disconnect is idempotent before and after connecting', t => {
  const f = fixture(t); f.manager.disconnect(); f.manager.disconnect();
  f.manager.connect('wss://one'); f.manager.disconnect(); f.manager.disconnect();
  assert.equal(f.timers.size, 0); assert.equal(f.sockets.length, 1);
});

test('unfinished outgoing offer cannot write into a replacement session', async t => {
  const f = fixture(t); let resolveOffer;
  f.waits.offer = new Promise(resolve => { resolveOffer = resolve; });
  f.manager.connect('wss://one');
  const handling = f.sockets[0].onmessage({ data: '{"type":"peer-joined","peerId":"remote"}' });
  f.manager.connect('wss://two'); resolveOffer({ type: 'offer' }); await handling;
  assert.equal(f.peers[0].closed, true);
  assert.deepEqual(f.peers[0].localDescriptions, []);
  assert.deepEqual(f.sockets[1].sent, []);
});

test('unfinished remote description cannot answer after disconnect', async t => {
  const f = fixture(t); let resolveRemote;
  f.waits.remote = new Promise(resolve => { resolveRemote = resolve; });
  f.manager.connect('wss://one');
  const handling = f.sockets[0].onmessage({ data: '{"type":"offer","peerId":"remote","offer":{}}' });
  f.manager.disconnect(); resolveRemote(); await handling;
  assert.equal(f.peers[0].answers, 0); assert.deepEqual(f.sockets[0].sent, []);
});

test('late peer/channel callbacks cannot revive a disconnected manager', async t => {
  const f = fixture(t); const online = [], errors = [];
  f.manager.on('online', () => online.push(true)); f.manager.on('error', e => errors.push(e));
  f.manager.connect('wss://one');
  await f.sockets[0].onmessage({ data: '{"type":"peer-joined","peerId":"remote"}' });
  const peer = f.peers[0], channel = peer.channel;
  f.manager.disconnect(); channel.readyState = 'open'; channel.onopen();
  peer.onicecandidate({ candidate: {} }); peer.onicecandidateerror({ errorCode: 1 });
  assert.equal(f.manager.isConnected(), false); assert.deepEqual(online, []);
  assert.deepEqual(errors, []); assert.equal(f.timers.size, 0);
});

test('replacing a connected session resets public online state', async t => {
  const f = fixture(t); f.manager.connect('wss://one');
  await f.sockets[0].onmessage({ data: '{"type":"peer-joined","peerId":"remote"}' });
  const channel = f.peers[0].channel; channel.readyState = 'open'; channel.onopen();
  assert.equal(f.manager.isConnected(), true);
  const offline = []; f.manager.on('offline', () => offline.push(true));
  f.manager.connect('wss://two');
  assert.equal(f.manager.isConnected(), false); assert.equal(offline.length, 1);
  channel.onclose(); assert.equal(offline.length, 1);
});

test('replaced peer closing its registered channel updates online state', async t => {
  const f = fixture(t); f.manager.connect('wss://one');
  await f.sockets[0].onmessage({ data: '{"type":"peer-joined","peerId":"remote"}' });
  const old = f.peers[0].channel; old.readyState = 'open'; old.onopen();
  const offline = []; f.manager.on('offline', () => offline.push(true));
  await f.sockets[0].onmessage({ data: '{"type":"offer","peerId":"remote","offer":{}}' });
  old.readyState = 'closed'; old.onclose();
  assert.equal(f.manager.isConnected(), false);
  assert.equal(offline.length, 1);
  old.onclose(); assert.equal(offline.length, 1);
});

test('old channel close cannot remove an already opened replacement channel', async t => {
  const f = fixture(t); f.manager.connect('wss://one');
  await f.sockets[0].onmessage({ data: '{"type":"peer-joined","peerId":"remote"}' });
  const old = f.peers[0].channel; old.readyState = 'open'; old.onopen();
  await f.sockets[0].onmessage({ data: '{"type":"offer","peerId":"remote","offer":{}}' });
  const next = { readyState: 'open' }; f.peers[1].ondatachannel({ channel: next }); next.onopen();
  const offline = []; f.manager.on('offline', () => offline.push(true));
  old.readyState = 'closed'; old.onclose();
  assert.equal(f.manager.isConnected(), true); assert.equal(offline.length, 0);
  next.readyState = 'closed'; next.onclose();
  assert.equal(f.manager.isConnected(), false); assert.equal(offline.length, 1);
});
