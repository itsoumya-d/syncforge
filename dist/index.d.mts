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
    constructor(peerId: string);
    connect(signalingUrl: string, roomId?: string): void;
    disconnect(): void;
    broadcast(operation: Operation): void;
    private handleRemoteData;
    onRemoteOperation(callback: (op: Operation) => void): void;
    receive(operation: Operation): void;
    getVectorClock(): VectorClock;
}

declare class Collection extends EventEmitter {
    private name;
    private db;
    private storage;
    private sync;
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
    private applyOperationLocally;
}

declare class SyncForge extends EventEmitter {
    peerId: string;
    private dbName;
    private collections;
    private syncManager;
    private storage;
    constructor(options?: any);
    collection(name: string): Collection;
    connectPeer(signalingUrl: string): void;
    disconnect(): void;
    exportData(): Promise<string>;
    importData(json: string): Promise<void>;
}

declare class LWWRegister<T> {
    value: T | null;
    timestamp: number;
    peerId: string;
    constructor(value?: T | null, timestamp?: number, peerId?: string);
    set(value: T, timestamp: number, peerId: string): void;
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
    merge(other: ORSet<T>): void;
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
