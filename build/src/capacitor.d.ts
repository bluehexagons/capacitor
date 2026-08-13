export type Comparator<V> = (a: V, b: V) => boolean;
export type ConfirmedConflictPolicy = 'reject' | 'replace';
export type CommitResult = {
    kind: 'new';
} | {
    kind: 'duplicate';
} | {
    kind: 'corrected';
    rollbackFrame: number;
} | {
    kind: 'conflict';
    rollbackFrame: number;
} | {
    kind: 'stale';
} | {
    kind: 'outside-window';
} | {
    kind: 'inactive';
};
export type ClientFrameStatus = 'confirmed' | 'predicted' | 'empty';
export type Predictor<V> = (prev: V | null, frame: number) => V | null;
export interface ClientProps<V> {
    comparator?: Comparator<V>;
    startFrame?: number;
    sizeOffset?: number;
    historyFrames?: number;
    predictor?: Predictor<V>;
    confirmedConflict?: ConfirmedConflictPolicy;
}
export type CapacitorClientProps<V> = Omit<ClientProps<V>, 'comparator'>;
export declare class Client<V> {
    comparator: Comparator<V>;
    startFrame: number;
    endFrame: number;
    capacity: number;
    baseFrame: number;
    confirmedHead: number;
    writtenHead: number;
    dirtyFrame: number;
    predictor: Predictor<V> | null;
    confirmedConflict: ConfirmedConflictPolicy;
    private values;
    private status;
    cache: V | null;
    get size(): number;
    get sizeOffset(): number;
    constructor({ comparator, startFrame, sizeOffset, historyFrames, predictor, confirmedConflict, }: ClientProps<V>);
    resync(frame: number): void;
    deactivate(frame: number): void;
    trimBefore(frame: number): void;
    commit(frame: number, value: V): CommitResult;
    commitIfEmpty(frame: number, value: V): CommitResult;
    hasValue(frame: number): boolean;
    predict(frame: number, value: V): CommitResult;
    private write;
    private ensureCapacity;
    private advanceBaseFrame;
    private advanceConfirmedHead;
    private markDirty;
    consumeDirty(): number | null;
    read(frame: number): V | null;
    frameStatus(frame: number): ClientFrameStatus;
    ensurePredicted(frame: number): void;
    invalidatePredictedFrom(frame: number): number;
}
export interface CapacitorReadResult<V> {
    confirmed: boolean;
    complete: boolean;
    rollbackFrame: number | null;
    values: (V | null)[];
    clients: CapacitorClientReadResult<V>[];
}
export interface CapacitorClientReadResult<V> {
    client: Client<V>;
    status: ClientFrameStatus;
    value: V | null;
    active: boolean;
}
export interface ResolveFrameOptions {
    predict?: boolean;
    maxPredictionLead?: number;
}
export declare class Capacitor<V> {
    comparator: Comparator<V>;
    clients: Set<Client<V>>;
    private detachedDirtyFrame;
    constructor(comparator: Comparator<V>);
    connect(props?: CapacitorClientProps<V>): Client<V>;
    disconnect(client: Client<V>): void;
    consumeDirty(): number | null;
    trimBefore(frame: number): void;
    ensurePredicted(frame: number): void;
    invalidatePredictedFrom(frame: number): void;
    resync(frame: number): void;
    readConfirmed(frame: number): boolean;
    read(frame: number): boolean;
    readDetailed(frame: number): CapacitorReadResult<V>;
    resolveFrame(frame: number, options?: ResolveFrameOptions): CapacitorReadResult<V>;
    pendingClients(frame: number): Client<V>[];
    clear(): void;
    size(): number;
}
