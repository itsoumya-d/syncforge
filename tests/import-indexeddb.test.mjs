import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { SyncForge } from '../dist/index.mjs';

function database(factory, dbName, peerId) {
  const previous = globalThis.indexedDB;
  globalThis.indexedDB = factory;
  try { return new SyncForge({ dbName, peerId }); }
  finally {
    if (previous === undefined) delete globalThis.indexedDB;
    else globalThis.indexedDB = previous;
  }
}

async function incrementSnapshot() {
  const source = new SyncForge({ dbName: 'source', peerId: 'source' });
  await source.collection('items').increment('one', 'count', 3);
  return source.exportData();
}

test('IndexedDB restore is committed before await and replay-safe after reopening', async () => {
  const factory = new IDBFactory();
  const original = await incrementSnapshot();
  const first = database(factory, 'persistent', 'first');
  await first.importData(original);
  assert.deepEqual(await first.collection('items').get('one'), { count: 3 });
  assert.deepEqual(JSON.parse(await first.exportData()), JSON.parse(original));
  first.storage.db.close();
  const reopened = database(factory, 'persistent', 'reopened');
  await reopened.importData(original);
  assert.deepEqual(await reopened.collection('items').get('one'), { count: 3 });
  assert.equal(JSON.parse(await reopened.exportData()).length, 1);
  reopened.storage.db.close();
});

for (const failure of ['metadata', 'document', 'log', 'after-request-success']) {
  test(`IndexedDB ${failure} failure rolls back the whole operation and allows retry`, async (t) => {
    const factory = new IDBFactory();
    const restored = database(factory, `failure-${failure}`, 'local');
    await restored.collection('items').set('one', { label: 'Original' });
    await restored.collection('items').increment('one', 'count', 2);
    const original = await incrementSnapshot();
    const originalPut = IDBObjectStore.prototype.put;
    t.after(() => { IDBObjectStore.prototype.put = originalPut; restored.storage.db?.close(); });
    let injected = false;
    IDBObjectStore.prototype.put = function(value, ...args) {
      const target = failure === 'metadata' ? this.name === 'documents' && value.collection === 'items_meta'
        : failure === 'document' ? this.name === 'documents' && value.collection === 'items'
        : this.name === 'operations';
      if (!injected && target) {
        injected = true;
        if (failure === 'after-request-success') {
          const request = originalPut.call(this, value, ...args);
          request.addEventListener('success', () => this.transaction.abort());
          return request;
        }
        throw new Error(`injected ${failure} failure`);
      }
      return originalPut.call(this, value, ...args);
    };
    await assert.rejects(restored.importData(original));
    assert.equal(injected, true);
    assert.deepEqual(await restored.collection('items').get('one'), { label: 'Original', count: 2 });
    assert.equal(JSON.parse(await restored.exportData()).length, 2);
    IDBObjectStore.prototype.put = originalPut;
    await restored.importData(original);
    await restored.importData(original);
    assert.deepEqual(await restored.collection('items').get('one'), { label: 'Original', count: 5 });
    assert.equal(JSON.parse(await restored.exportData()).length, 3);
  });
}
