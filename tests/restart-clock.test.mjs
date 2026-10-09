import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { SyncForge } from '../dist/index.mjs';
function database(factory, dbName, peerId) {
 const previous=globalThis.indexedDB; globalThis.indexedDB=factory;
 try { return new SyncForge({dbName,peerId}); }
 finally { if(previous===undefined)delete globalThis.indexedDB;else globalThis.indexedDB=previous; }
}
test('reopening with the same peer preserves distinct writes in exported history', async () => {
 const factory=new IDBFactory();
 const first=database(factory,'restart','stable-peer');
 await first.collection('items').set('first',{label:'First document'});
 first.storage.db.close();
 const reopened=database(factory,'restart','stable-peer');
 await reopened.collection('items').set('second',{label:'Second document'});
 const snapshot=await reopened.exportData();
 assert.equal(JSON.parse(snapshot).length,2,'both committed documents must remain in the exported log');
 const restored=new SyncForge({dbName:'restore',peerId:'other'});
 await restored.importData(snapshot);
 assert.deepEqual(await restored.collection('items').get('first'),{label:'First document'});
 assert.deepEqual(await restored.collection('items').get('second'),{label:'Second document'});
 reopened.storage.db.close();
});
test('reopening with the same peer can update an existing document', async()=>{
 const factory=new IDBFactory();const first=database(factory,'update','stable-peer');
 await first.collection('items').set('one',{label:'Before restart'});first.storage.db.close();
 const reopened=database(factory,'update','stable-peer');
 await reopened.collection('items').set('one',{label:'After restart'});
 assert.deepEqual(await reopened.collection('items').get('one'),{label:'After restart'});
 reopened.storage.db.close();
});

for (const peerId of ['stable-peer', 'different-peer', 'constructor', 'prototype', '__proto__']) {
 test(`all local mutation types follow persisted clocks after reopening as ${peerId}`, async(t)=>{
  const factory=new IDBFactory();const first=database(factory,peerId,'stable-peer');
  await first.importData(JSON.stringify([
   {id:'remote-100',type:'set',collection:'items',docId:'edit',field:'',value:{label:'Before'},timestamp:100,peerId:'remote'},
   {id:'remote-101',type:'set',collection:'items',docId:'remove',field:'',value:{label:'Remove'},timestamp:101,peerId:'remote'},
  ]));first.storage.db.close();
  const reopened=database(factory,peerId,peerId);t.after(()=>reopened.storage.db?.close());
  await Promise.all([
   reopened.collection('items').set('edit',{label:'After'}),
   reopened.collection('items').delete('remove'),
   reopened.collection('items').increment('counter','count',5),
   reopened.collection('items').decrement('counter','count',2),
  ]);
  const snapshot=await reopened.exportData();const operations=JSON.parse(snapshot);
  assert.equal(operations.length,6);assert.equal(new Set(operations.map(o=>o.id)).size,6);
  assert.deepEqual(operations.filter(o=>o.peerId===peerId).map(o=>o.timestamp).sort((a,b)=>a-b),[102,103,104,105]);
  const restored=new SyncForge({dbName:'new-target',peerId:'restored'});await restored.importData(snapshot);
  assert.deepEqual(await restored.collection('items').get('edit'),{label:'After'});
  assert.equal(await restored.collection('items').get('remove'),null);
  assert.deepEqual(await restored.collection('items').get('counter'),{count:3});
 });
}

test('concurrent writes wait for one history read and include remote clocks observed while waiting',async()=>{
 const db=new SyncForge({dbName:'delayed',peerId:'local'});
 let release;const blocked=new Promise(resolve=>{release=resolve;});let reads=0;
 db.storage.getOperations=async()=>{reads++;await blocked;return [{id:'old-50',peerId:'old',timestamp:50,type:'set',collection:'items',docId:'old',field:'',value:{}}];};
 const writes=[db.collection('items').increment('one','count'),db.collection('items').increment('one','count')];
 await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,1);assert.equal(await db.collection('items').get('one'),null);
 await db.syncManager.receive({id:'remote-100',peerId:'remote',timestamp:100,type:'set',collection:'items',docId:'remote',field:'',value:{}});
 release();await Promise.all(writes);assert.deepEqual(await db.collection('items').get('one'),{count:2});
 const local=[...db.storage.operations.values()].filter(o=>o.peerId==='local');assert.deepEqual(local.map(o=>o.timestamp),[101,102]);
});

test('failed initialization rejects all waiting writes without mutation and a later write retries',async()=>{
 const db=new SyncForge({dbName:'retry-clock',peerId:'local'});const original=db.storage.getOperations.bind(db.storage);let reads=0;
 db.storage.getOperations=async()=>{reads++;throw new Error('history unavailable');};
 const results=await Promise.allSettled([db.collection('items').set('one',{label:'No write'}),db.collection('items').increment('one','count')]);
 assert.equal(reads,1);for(const result of results){assert.equal(result.status,'rejected');assert.match(result.reason.message,/history unavailable/);}
 assert.equal(await db.collection('items').get('one'),null);assert.deepEqual(await original(),[]);
 db.storage.getOperations=original;await db.collection('items').set('one',{label:'Recovered'});
 assert.deepEqual(await db.collection('items').get('one'),{label:'Recovered'});assert.equal((await original())[0].timestamp,1);
});

test('malformed persisted history fails closed and permits recovery after history is repaired',async()=>{
 const db=new SyncForge({dbName:'invalid-clock',peerId:'local'});const original=db.storage.getOperations.bind(db.storage);
 db.storage.getOperations=async()=>[{id:'bad',timestamp:'50'}];
 await assert.rejects(db.collection('items').set('one',{label:'No write'}),/invalid operation/);
 assert.equal(await db.collection('items').get('one'),null);
 db.storage.getOperations=original;await db.collection('items').set('one',{label:'Recovered'});
 assert.deepEqual(await db.collection('items').get('one'),{label:'Recovered'});
});

test('IndexedDB history transaction abort after request success rejects write and permits retry',async(t)=>{
 const factory=new IDBFactory();const first=database(factory,'aborted-read','local');
 await first.collection('items').set('one',{label:'Original'});first.storage.db.close();
 const reopened=database(factory,'aborted-read','local');const original=IDBObjectStore.prototype.getAll;
 t.after(()=>{IDBObjectStore.prototype.getAll=original;reopened.storage.db?.close();});
 IDBObjectStore.prototype.getAll=function(...args){const request=original.apply(this,args);if(this.name==='operations')request.addEventListener('success',()=>this.transaction.abort());return request;};
 await assert.rejects(reopened.collection('items').set('one',{label:'Rejected'}),/history read aborted/);
 assert.deepEqual(await reopened.collection('items').get('one'),{label:'Original'});
 IDBObjectStore.prototype.getAll=original;
 assert.equal(JSON.parse(await reopened.exportData()).length,1);
 await reopened.collection('items').set('one',{label:'Recovered'});
 assert.deepEqual(await reopened.collection('items').get('one'),{label:'Recovered'});
 assert.equal(JSON.parse(await reopened.exportData()).length,2);
});

for (const peerId of ['constructor', 'prototype', '__proto__', 'toString']) {
 test(`reserved-looking peer ID ${peerId} keeps unique operation IDs across restart`, async(t) => {
  const factory = new IDBFactory();
  const first = database(factory, `reserved-${peerId}`, peerId);
  await first.collection('items').set('first', {label: 'First'});
  first.storage.db.close();
  const reopened = database(factory, `reserved-${peerId}`, peerId);
  t.after(() => reopened.storage.db?.close());
  await reopened.collection('items').set('second', {label: 'Second'});
  const operations = JSON.parse(await reopened.exportData());
  assert.deepEqual(operations.map(op => op.id), [`${peerId}-1`, `${peerId}-2`]);
 });
}

test('reopening under a new peer observes history from an inherited-looking peer name', async(t) => {
 const factory = new IDBFactory();
 const first = database(factory, 'inherited-peer', 'toString');
 await first.collection('items').set('one', {label: 'Before'});
 first.storage.db.close();
 const reopened = database(factory, 'inherited-peer', 'new-local');
 t.after(() => reopened.storage.db?.close());
 await reopened.collection('items').set('one', {label: 'After'});
 assert.deepEqual(await reopened.collection('items').get('one'), {label: 'After'});
 const operations = JSON.parse(await reopened.exportData());
 assert.equal(operations.find(op => op.peerId === 'new-local').timestamp, 2);
});

test('exhausted persisted clock rejects local writes without overwriting history', async(t) => {
 const factory = new IDBFactory();
 const first = database(factory, 'exhausted-clock', 'old');
 await first.collection('items').set('old', {label: 'Preserve'});
 await first.importData(JSON.stringify([{id: 'max', type: 'inc', collection: 'items', docId: 'old',
  field: 'count', value: 1, peerId: 'old', timestamp: Number.MAX_SAFE_INTEGER}]));
 first.storage.db.close();
 const reopened = database(factory, 'exhausted-clock', 'local');
 t.after(() => reopened.storage.db?.close());
 const results = await Promise.allSettled([
  reopened.collection('items').set('one', {label: 'No write'}),
  reopened.collection('items').increment('two', 'count'),
 ]);
 for (const result of results) {
  assert.equal(result.status, 'rejected');
  assert.match(result.reason.message, /logical clock exhausted/);
 }
 assert.equal(await reopened.collection('items').get('one'), null);
 assert.equal(await reopened.collection('items').get('two'), null);
 assert.deepEqual(await reopened.collection('items').get('old'), {label: 'Preserve', count: 1});
 assert.deepEqual(JSON.parse(await reopened.exportData()).map(op => op.id).sort(), ['max', 'old-1']);
});

for (const peerId of ['constructor', 'prototype', '__proto__']) {
 test(`validated remote clock from ${peerId} survives a concurrent startup history read`, async () => {
  const db = new SyncForge({dbName: `remote-${peerId}`, peerId: 'local'});
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  db.storage.getOperations = async () => { await blocked; return []; };
  const local = db.collection('items').set('one', {label: 'After remote'});
  await db.syncManager.receive({id: `${peerId}-100`, type: 'set', collection: 'items', docId: 'one',
   field: '', value: {label: 'Before local'}, timestamp: 100, peerId});
  release();
  await local;
  assert.deepEqual(await db.collection('items').get('one'), {label: 'After remote'});
  assert.equal([...db.storage.operations.values()].find(op => op.peerId === 'local').timestamp, 101);
 });
}
