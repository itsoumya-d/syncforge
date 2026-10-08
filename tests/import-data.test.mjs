import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SyncForge } from '../dist/index.mjs';

const database = (peerId) => new SyncForge({ dbName: `restore-${peerId}`, peerId });

async function snapshot() {
  const source = database('source');
  await source.collection('todos').set('one', { title: 'Keep this task' });
  await source.collection('todos').increment('one', 'votes', 5);
  await source.collection('todos').decrement('one', 'votes', 2);
  await source.collection('archive').set('old', { title: 'Deleted task' });
  await source.collection('archive').delete('old');
  return source.exportData();
}

describe('snapshot restoration', () => {
  test('restores unopened collections before the import promise resolves', async () => {
    const restored = database('restored');
    await restored.importData(await snapshot());
    assert.deepEqual(await restored.collection('todos').get('one'), {
      title: 'Keep this task', votes: 3,
    });
    assert.equal(await restored.collection('archive').get('old'), null);
  });

  test('waits for writes in collections that were already opened', async () => {
    const restored = database('opened');
    const todos = restored.collection('todos');
    await restored.importData(await snapshot());
    assert.deepEqual(await todos.get('one'), { title: 'Keep this task', votes: 3 });
  });

  test('preserves restored operations in the next exported snapshot', async () => {
    const first = database('first');
    const original = await snapshot();
    await first.importData(original);
    assert.deepEqual(JSON.parse(await first.exportData()), JSON.parse(original));
    const second = database('second');
    await second.importData(await first.exportData());
    assert.deepEqual(await second.collection('todos').get('one'), {
      title: 'Keep this task', votes: 3,
    });
  });

  test('overlapping and repeated imports do not duplicate counters or log entries', async () => {
    const restored = database('concurrent');
    const original = await snapshot();
    await Promise.all([restored.importData(original), restored.importData(original)]);
    await restored.importData(original);
    assert.deepEqual(await restored.collection('todos').get('one'), {
      title: 'Keep this task', votes: 3,
    });
    assert.equal(JSON.parse(await restored.exportData()).length, JSON.parse(original).length);
  });
});

test('a slow storage commit keeps every overlapping import pending', async () => {
  const restored = database('slow');
  const original = await snapshot();
  const commit = restored.storage.commitOperation.bind(restored.storage);
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  restored.storage.commitOperation = async (...args) => {
    started();
    await blocked;
    return commit(...args);
  };
  let finished = 0;
  const first = restored.importData(original).then(() => finished++);
  await entered;
  const second = restored.importData(original).then(() => finished++);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, 0);
  release();
  await Promise.all([first, second]);
  assert.equal(finished, 2);
  assert.equal((await restored.collection('todos').get('one')).votes, 3);
});

test('a failed memory commit rejects, leaves metadata unchanged and permits retry', async () => {
  const restored = database('retry');
  await restored.collection('todos').set('one', { title: 'Keep this task' });
  await restored.collection('todos').increment('one', 'votes', 2);
  const source = database('retry-source');
  await source.collection('todos').increment('one', 'votes', 3);
  const original = await source.exportData();
  const commit = restored.storage.commitOperation.bind(restored.storage);
  restored.storage.commitOperation = async () => { throw new Error('storage full'); };
  await assert.rejects(restored.importData(original), /storage full/);
  assert.equal((await restored.collection('todos').get('one')).votes, 2);
  assert.equal(restored.storage.collections.get('todos_meta').get('one').counterData.votes.positives.retry, 2);
  restored.storage.commitOperation = commit;
  await restored.importData(original);
  await restored.importData(original);
  assert.equal((await restored.collection('todos').get('one')).votes, 5);
  assert.equal(JSON.parse(await restored.exportData()).length, 3);
});

test('invalid snapshot records are rejected before any prefix is applied', async () => {
  const restored = database('invalid');
  const operations = JSON.parse(await snapshot());
  operations.push({ ...operations[0], id: 'invalid', type: 'unsupported' });
  await assert.rejects(restored.importData(JSON.stringify(operations)), /invalid operation/);
  assert.equal(await restored.collection('todos').get('one'), null);
  assert.equal(await restored.exportData(), '[]');
});

test('a local write after receiving an operation is stamped after its clock', async () => {
  const restored = database('clock');
  const op = { id: 'remote-100', type: 'set', collection: 'todos', docId: 'one',
    field: '', value: { title: 'Remote' }, timestamp: 100, peerId: 'remote' };
  const received = restored.syncManager.receive(op);
  await restored.collection('todos').set('one', { title: 'Local after remote' });
  await received;
  assert.equal((await restored.collection('todos').get('one')).title, 'Local after remote');
});

test('writes from change listeners follow the imported operation clock', async () => {
  const restored = database('reactive');
  let reaction;
  restored.on('change', () => {
    if (!reaction) reaction = restored.collection('todos').set('one', { title: 'Local reaction' });
  });
  await restored.importData(JSON.stringify([{ id: 'remote-50', type: 'set', collection: 'todos',
    docId: 'one', field: '', value: { title: 'Remote' }, timestamp: 50, peerId: 'remote' }]));
  await reaction;
  assert.equal((await restored.collection('todos').get('one')).title, 'Local reaction');
});

test('retrying a partially committed snapshot skips its successful prefix', async () => {
  const restored = database('partial');
  const original = await snapshot();
  const commit = restored.storage.commitOperation.bind(restored.storage);
  let failed = false;
  restored.storage.commitOperation = async (...args) => {
    if (!failed && args[4].type === 'inc') {
      failed = true;
      throw new Error('temporary storage failure');
    }
    return commit(...args);
  };
  await assert.rejects(restored.importData(original), /temporary storage failure/);
  assert.deepEqual(await restored.collection('todos').get('one'), { title: 'Keep this task' });
  assert.equal(JSON.parse(await restored.exportData()).length, 1);
  await restored.importData(original);
  assert.deepEqual(await restored.collection('todos').get('one'), { title: 'Keep this task', votes: 3 });
  assert.equal(JSON.parse(await restored.exportData()).length, JSON.parse(original).length);
});
