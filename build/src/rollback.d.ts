export type RollbackRefusalReason = 'out-of-window' | 'unsafe-boundary' | 'missing-snapshot';
export interface RollbackRingOptions<Snapshot, SaveArgs extends unknown[]> {
    window?: number;
    createSnapshot: () => Snapshot;
    saveSnapshot: (snapshot: Snapshot, frame: number, ...args: SaveArgs) => void;
    loadSnapshot: (snapshot: Snapshot, frame: number) => void;
}
export declare class RollbackRing<Snapshot, UnsafeReason = string, SaveArgs extends unknown[] = []> {
    readonly window: number;
    private readonly slots;
    private readonly occupied;
    private readonly saveSnapshot;
    private readonly loadSnapshot;
    unsafeSinceFrame: number;
    unsafeReasons: UnsafeReason[];
    constructor({ window, createSnapshot, saveSnapshot, loadSnapshot, }: RollbackRingOptions<Snapshot, SaveArgs>);
    private slotIndex;
    save(frame: number, ...args: SaveArgs): void;
    refusalReason(frame: number): RollbackRefusalReason | null;
    load(frame: number): number;
    peek(frame: number): Snapshot | null;
    markUnsafe(frame: number, reason: UnsafeReason): void;
    clear(): void;
    private assertFrame;
}
export declare class RollbackCorrectionQueue {
    private deferredFrame;
    get deferred(): number | null;
    consumeEarliest(consumeDirty: () => number | null): number | null;
    defer(frame: number): void;
    clear(consumeDirty: () => number | null): void;
}
