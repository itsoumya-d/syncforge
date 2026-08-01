type Document = Record<string, any>;
interface SyncForgeOptions {
    dbName: string;
    peerId?: string;
}

declare class Query {
    private _where;
    private _orderBy?;
    private _limit?;
    private collection;
    constructor(collection: Collection);
    where(field: string, op: '==' | '!=' | '>' | '<' | '>=' | '<=', value: any): Query;
    orderBy(field: string, direction?: 'asc' | 'desc'): Query;
    limit(n: number): Query;
    execute(docs: Document[]): Document[];
    get(): Promise<Document[]>;
    subscribe(callback: (docs: Document[]) => void): () => void;
}

declare class EventEmitter {
    private listeners;
    on(event: string, callback: Function): void;
    /**
     * Notify listeners. Each listener is isolated: a listener that throws is
     * reported and the remaining listeners still run.
     *
     * Previously a single throwing listener aborted the whole dispatch loop.
     * Because `emit('change', ...)` is called synchronously from inside
     * `Collection.applyOperationLocally`, one buggy application callback both
     * starved every later subscriber and made an already-persisted `set()`
     * reject — leaving the caller unable to tell whether the write landed.
     */
    emit(event: string, ...args: any[]): void;
    off(event: string, callback: Function): void;
}

type OperationType = 'set' | 'delete' | 'inc' | 'dec' | 'add' | 'remove';
interface Operation {
    id: string;
    type: OperationType;
    collection: string;
    docId: string;
    field: string;
    value: any;
    timestamp: number;
    peerId: string;
}

interface StorageAdapter {
    get(collection: string, id: string): Promise<any>;
    set(collection: string, id: string, data: any): Promise<void>;
    delete(collection: string, id: string): Promise<void>;
    getAll(collection: string): Promise<any[]>;
    saveOperation(op: Operation): Promise<void>;
    getOperations(): Promise<Operation[]>;
}

declare class VectorClock {
    private clocks;
    private localPeerId;
    constructor(localPeerId: string);
    /**
     * Stamp a new local operation.
     *
     * This follows the Lamport send rule: the returned timestamp is strictly
     * greater than every timestamp this replica has already observed, so a write
     * that happens-after a remote operation always carries a higher timestamp
     * than that operation.
     *
     * Previously this only incremented the local entry, which meant a replica
     * that had made fewer writes than a peer produced timestamps *below* the
     * timestamps it had already seen. Last-writer-wins then silently discarded
     * the replica's own local write.
     */
    increment(): number;
    update(remoteClock: Record<string, number>): void;
    getClock(): Record<string, number>;
    getTimestamp(): number;
}

declare class SyncManager extends EventEmitter {
    private peerId;
    private vectorClock;
    private connected;
    private transport;
    /**
     * Operation ids already applied, for at-least-once delivery.
     *
     * `set`/`delete` are idempotent (last-writer-wins), but `inc`/`dec` are not:
     * re-applying an increment adds the amount again. Without dedup, duplicate
     * delivery (a retry, a resync, or `importData()` of a snapshot that overlaps
     * the local log) permanently diverged counters between replicas.
     *
     * Bounded FIFO so a long-lived session cannot grow it without limit.
     */
    private appliedOps;
    private appliedOrder;
    private static readonly MAX_APPLIED_OPS;
    constructor(peerId: string);
    /**
     * Begin connecting.
     *
     * This does NOT mean the peer is online. `connect()` used to set
     * `connected = true` and emit 'online' synchronously, before the signaling
     * socket had even opened — so the caller was told it was online even when the
     * host did not exist, and was never told otherwise. 'online' is now emitted
     * when the first peer data channel actually opens, and 'offline' when the
     * last one closes or signaling fails permanently.
     */
    connect(signalingUrl: string, roomId?: string): void;
    /** True only when at least one peer data channel is open. */
    isConnected(): boolean;
    disconnect(): void;
    /**
     * Encode and fan out an operation.
     *
     * Returns the number of peers it reached. 0 means the operation exists only
     * locally: there is no outbox, so it will NOT be retried or replayed when a
     * peer later connects. Callers that need guaranteed propagation must track
     * this themselves (see `exportData()` / `importData()`).
     */
    broadcast(operation: Operation): number;
    /**
     * Decode an inbound frame.
     *
     * Every length field is attacker-controlled: a peer only needs the room id to
     * send arbitrary bytes (there is no authentication). Previously the header
     * parse sat *outside* the try/catch, so a 1-byte frame threw
     * `RangeError: Offset is outside the bounds of the DataView` straight out of
     * the data-channel `onmessage` handler, and a frame declaring a huge length
     * threw `RangeError: Invalid typed array length`. Every read is now bounds
     * checked against the real buffer length and the whole body is guarded.
     */
    private handleRemoteData;
    onRemoteOperation(callback: (op: Operation) => void): void;
    /**
     * Apply an operation received from a peer (or replayed from a snapshot).
     *
     * Duplicates are dropped by operation id so that at-least-once delivery is
     * safe for the non-idempotent `inc`/`dec` operations.
     */
    receive(operation: Operation): void;
    /** Record a locally generated operation id so an echo of it is ignored. */
    markApplied(operationId: string): void;
    getVectorClock(): VectorClock;
}

declare class Collection extends EventEmitter {
    private name;
    private db;
    private storage;
    private sync;
    /**
     * Per-document serialisation chain.
     *
     * `applyOperationLocally` is a read-modify-write over the stored `_meta`
     * record. Without serialisation two overlapping operations on the same
     * document both read the same pre-state and the second write clobbers the
     * first, so e.g. `Promise.all([col.increment(...) x10])` produced 1 instead
     * of 10. Operations on the same document are now queued; operations on
     * different documents still run concurrently.
     */
    private applyQueues;
    constructor(name: string, db: SyncForge, storage: StorageAdapter, sync: SyncManager);
    set(id: string, data: object): Promise<void>;
    get(id: string): Promise<Document | null>;
    delete(id: string): Promise<void>;
    getAll(): Promise<Document[]>;
    where(field: string, op: '==' | '!=' | '>' | '<' | '>=' | '<=', value: any): Query;
    orderBy(field: string, direction?: 'asc' | 'desc'): Query;
    limit(n: number): Query;
    subscribe(callback: (docs: Document[]) => void): () => void;
    subscribeDoc(id: string, callback: (doc: Document | null) => void): () => void;
    increment(id: string, field: string, amount?: number): Promise<void>;
    decrement(id: string, field: string, amount?: number): Promise<void>;
    /**
     * Queue `op` behind any in-flight operation for the same document, so the
     * read-modify-write below can never interleave with itself.
     */
    private applyOperationLocally;
    private static assertSerialisable;
    private applyOperationUnsafe;
}

declare class SyncForge extends EventEmitter {
    peerId: string;
    private dbName;
    private collections;
    private syncManager;
    private storage;
    constructor(options: SyncForgeOptions);
    /** True only when at least one peer data channel is open. */
    isOnline(): boolean;
    collection(name: string): Collection;
    connectPeer(signalingUrl: string): void;
    disconnect(): void;
    exportData(): Promise<string>;
    /**
     * Replay an operation log produced by `exportData()`.
     *
     * Operations already applied are skipped by operation id, so importing the
     * same snapshot twice is now a no-op. Previously every `inc`/`dec` in the
     * snapshot was applied again, so `importData(await exportData())` silently
     * doubled every counter in the database.
     */
    importData(json: string): Promise<void>;
}

declare class LWWRegister<T> {
    value: T | null;
    timestamp: number;
    peerId: string;
    constructor(value?: T | null, timestamp?: number, peerId?: string);
    /**
     * Apply a write, keeping the winner of a total order on
     * (timestamp, peerId, value).
     *
     * The third level is required for convergence. With only (timestamp, peerId)
     * the case "same timestamp, same peer, different value" was unordered, so the
     * incumbent value was kept and `merge` stopped being commutative:
     * merge(a,b) !== merge(b,a). That is reachable in ordinary use, because the
     * documented usage passes `Date.now()` — a clock with 1 ms granularity — so
     * any two writes by the same peer inside the same millisecond tie. Measured:
     * 198 of 200 back-to-back writes were silently discarded, and two replicas
     * that each kept a different survivor never reconverged.
     *
     * Note that ties are therefore resolved by value order, not by wall-clock
     * arrival order. If you need "last write wins" between writes closer together
     * than your clock's resolution, supply a monotonically increasing counter
     * instead of `Date.now()` (this is what `Collection` does internally).
     */
    set(value: T, timestamp: number, peerId: string): void;
    private wins;
    /** Stable, order-independent key used only as the final tie-break. */
    private static rank;
    merge(other: LWWRegister<T>): void;
}

declare class GCounter {
    counts: Record<string, number>;
    constructor(counts?: Record<string, number>);
    increment(peerId: string, amount?: number): void;
    get value(): number;
    merge(other: GCounter): void;
}

declare class PNCounter {
    positives: GCounter;
    negatives: GCounter;
    constructor(positives?: Record<string, number>, negatives?: Record<string, number>);
    increment(peerId: string, amount?: number): void;
    decrement(peerId: string, amount?: number): void;
    get value(): number;
    merge(other: PNCounter): void;
}

declare class ORSet<T> {
    added: Map<string, T>;
    removed: Set<string>;
    constructor();
    add(id: string, value: T): void;
    remove(id: string): void;
    get values(): T[];
    has(value: T): boolean;
    /**
     * Merge another replica's state into this one.
     *
     * A tag is supposed to identify a single add event, so the value bound to a
     * tag should be immutable. Nothing enforces that, and this used to blindly
     * overwrite: if two replicas bound the same tag to different values, then
     * `A.merge(B)` and `B.merge(A)` produced different results and the replicas
     * never reconverged. (Property test counterexample: A={t1:'apple'},
     * B={t1:'banana'} -> ['banana'] vs ['apple'].)
     *
     * Conflicting bindings are now resolved by a deterministic total order on the
     * serialised value, which makes merge commutative and associative regardless
     * of how the tags were generated.
     */
    merge(other: ORSet<T>): void;
    /** Stable, order-independent key used only to break tag-collision ties. */
    private static rank;
}

declare class LWWMap {
    data: Map<string, LWWRegister<any>>;
    private static readonly MAX_KEYS;
    private static readonly MAX_FUTURE_DRIFT_MS;
    constructor();
    private isTimestampValid;
    private sanitizeKey;
    set(key: string, value: any, timestamp: number, peerId: string): void;
    get(key: string): any;
    delete(key: string, timestamp: number, peerId: string): void;
    toJSON(): Record<string, any>;
    merge(other: LWWMap): void;
    toBuffer(): ArrayBuffer;
    static fromBuffer(buffer: ArrayBuffer): LWWMap;
    delta(sinceTimestamp: number): LWWMap;
}

declare class IndexedDBAdapter implements StorageAdapter {
    private dbName;
    private db;
    private ready;
    constructor(dbName: string);
    private init;
    get(collection: string, id: string): Promise<any>;
    set(collection: string, id: string, data: any): Promise<void>;
    delete(collection: string, id: string): Promise<void>;
    getAll(collection: string): Promise<any[]>;
    saveOperation(op: Operation): Promise<void>;
    getOperations(): Promise<Operation[]>;
}

declare class MemoryAdapter implements StorageAdapter {
    /**
     * Map-backed store.
     *
     * This used to be a plain object indexed by the collection name, so a
     * collection called `__proto__` resolved `this.collections['__proto__']` to
     * `Object.prototype` (truthy, so the initialiser was skipped) and the next
     * line wrote a document straight onto `Object.prototype` — process-wide
     * prototype pollution. A document id of `__proto__` likewise reassigned the
     * collection object's prototype. `Map` keys cannot collide with prototype
     * members, which closes both vectors.
     */
    private collections;
    private operations;
    get(collection: string, id: string): Promise<any>;
    set(collection: string, id: string, data: any): Promise<void>;
    delete(collection: string, id: string): Promise<void>;
    getAll(collection: string): Promise<any[]>;
    saveOperation(op: Operation): Promise<void>;
    getOperations(): Promise<Operation[]>;
}

export { Collection, type Document, EventEmitter, GCounter, IndexedDBAdapter, LWWMap, LWWRegister, MemoryAdapter, ORSet, type Operation, type OperationType, PNCounter, Query, type StorageAdapter, SyncForge, type SyncForgeOptions, SyncManager, VectorClock };
