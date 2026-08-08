import type { CommitResult } from './capacitor.js';
export interface FrameSource<V> {
    startFrame: number;
    baseFrame: number;
    confirmedHead: number;
    read(frame: number): V | null;
}
export interface FrameTarget<V> {
    startFrame: number;
    confirmedHead: number;
    commit(frame: number, value: V): CommitResult;
}
export interface CollectedFrame<V> {
    sourceIndex: number;
    frame: number;
    frameOffset: number;
    value: V;
}
export interface CollectedFrameBatch<V> {
    entries: CollectedFrame<V>[];
    sentThroughFrame: number;
}
export interface CollectFrameBatchOptions<V> {
    sources: readonly FrameSource<V>[];
    originFrame: number;
    throughFrame: number;
    maxEntries: number;
    maxFrameSpan?: number;
}
export declare const collectFrameBatch: <V>({ sources, originFrame, throughFrame, maxEntries, maxFrameSpan, }: CollectFrameBatchOptions<V>) => CollectedFrameBatch<V>;
export interface FrameBatchEntry<K, V> {
    target: K;
    frameOffset: number;
    value: V;
}
export interface AcceptedFrameBatchEntry<K, V> {
    entry: FrameBatchEntry<K, V>;
    localFrame: number;
}
export interface AppliedFrameBatch<K, V> {
    receivedThroughFrame: number;
    acceptedEntries: AcceptedFrameBatchEntry<K, V>[];
    unknownTargetEntries: FrameBatchEntry<K, V>[];
    staleEntries: FrameBatchEntry<K, V>[];
    futureEntries: FrameBatchEntry<K, V>[];
    invalidEntries: FrameBatchEntry<K, V>[];
    rejectedEntries: FrameBatchEntry<K, V>[];
}
export interface ApplyFrameBatchOptions<K, V> {
    targets: ReadonlyMap<K, FrameTarget<V>>;
    entries: readonly FrameBatchEntry<K, V>[];
    originFrame: number;
    receivedThroughFrame: number;
    maxFrameLead: number;
}
export declare const applyFrameBatch: <K, V>({ targets, entries, originFrame, receivedThroughFrame, maxFrameLead, }: ApplyFrameBatchOptions<K, V>) => AppliedFrameBatch<K, V>;
