import type { CommitResult } from './capacitor.js';

/** A readable, contiguous source of confirmed frame values. */
export interface FrameSource<V> {
  /** First absolute frame available from this source. */
  startFrame: number;
  /** Oldest absolute frame still retained by this source. */
  baseFrame: number;
  /** First absolute frame not yet confirmed by this source. */
  confirmedHead: number;
  read(frame: number): V | null;
}

/** A target that can accept confirmed frame values. */
export interface FrameTarget<V> {
  /** First absolute frame accepted by this target. */
  startFrame: number;
  /** First absolute frame not yet contiguously confirmed by this target. */
  confirmedHead: number;
  commit(frame: number, value: V): CommitResult;
}

/** One frame selected for transport. The wire representation is consumer-defined. */
export interface CollectedFrame<V> {
  sourceIndex: number;
  frame: number;
  frameOffset: number;
  value: V;
}

export interface CollectedFrameBatch<V> {
  entries: CollectedFrame<V>[];
  /** First absolute frame fully covered for every source. */
  sentThroughFrame: number;
}

export interface CollectFrameBatchOptions<V> {
  sources: readonly FrameSource<V>[];
  /** First absolute frame represented by offset zero. */
  originFrame: number;
  /** Exclusive upper bound on frames eligible for collection. */
  throughFrame: number;
  /** Maximum total number of entries. */
  maxEntries: number;
  /** Maximum number of consecutive frame coordinates represented per source. */
  maxFrameSpan?: number;
}

const assertNonNegativeSafeInteger = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
};

const assertPositiveSafeInteger = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
};

/**
 * Select a bounded, fair batch of confirmed values from multiple frame sources.
 *
 * Each source receives the same frame-span budget. This prevents the first source
 * from consuming the whole entry budget when several players share a packet.
 * A source that violates its contiguous `confirmedHead` contract stops shared
 * progress at the missing frame so a caller never skips unsent input.
 */
export const collectFrameBatch = <V>({
  sources,
  originFrame,
  throughFrame,
  maxEntries,
  maxFrameSpan = maxEntries,
}: CollectFrameBatchOptions<V>): CollectedFrameBatch<V> => {
  assertNonNegativeSafeInteger('originFrame', originFrame);
  assertNonNegativeSafeInteger('throughFrame', throughFrame);
  assertPositiveSafeInteger('maxEntries', maxEntries);
  assertPositiveSafeInteger('maxFrameSpan', maxFrameSpan);

  if (throughFrame < originFrame) {
    throw new Error('throughFrame must be at or after originFrame');
  }

  if (sources.length === 0 || throughFrame === originFrame) {
    return { entries: [], sentThroughFrame: originFrame };
  }
  const fairFrameSpan = Math.max(1, Math.floor(maxEntries / sources.length));
  const frameSpan = Math.min(maxFrameSpan, fairFrameSpan);
  const entries: CollectedFrame<V>[] = [];
  let sentThroughFrame = throughFrame;

  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
    const source = sources[sourceIndex];
    assertNonNegativeSafeInteger(`sources[${sourceIndex}].startFrame`, source.startFrame);
    assertNonNegativeSafeInteger(`sources[${sourceIndex}].baseFrame`, source.baseFrame);
    assertNonNegativeSafeInteger(`sources[${sourceIndex}].confirmedHead`, source.confirmedHead);
    if (source.baseFrame < source.startFrame) {
      throw new Error(`sources[${sourceIndex}].baseFrame must be at or after startFrame`);
    }
    if (source.confirmedHead < source.startFrame) {
      throw new Error(`sources[${sourceIndex}].confirmedHead must be at or after startFrame`);
    }
    if (source.confirmedHead < source.baseFrame) {
      throw new Error(`sources[${sourceIndex}].confirmedHead must be at or after baseFrame`);
    }
    if (originFrame < source.baseFrame && source.baseFrame > source.startFrame) {
      throw new Error(`sources[${sourceIndex}] no longer retains originFrame`);
    }
    const start = Math.max(source.startFrame, source.baseFrame, originFrame);
    const end = Math.min(throughFrame, source.confirmedHead, originFrame + frameSpan);
    let sourceSentThroughFrame = Math.min(throughFrame, start);

    for (let frame = start; frame < end && entries.length < maxEntries; frame++) {
      const value = source.read(frame);
      if (value === null) break;

      entries.push({ sourceIndex, frame, frameOffset: frame - originFrame, value });
      sourceSentThroughFrame = frame + 1;
    }
    sentThroughFrame = Math.min(sentThroughFrame, sourceSentThroughFrame);
  }

  return { entries, sentThroughFrame };
};

/** A decoded frame value associated with a consumer-defined target key. */
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
  /** Updated contiguous receive frontier across every target. */
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
  /** Local absolute frame represented by offset zero. */
  originFrame: number;
  /** Existing contiguous receive frontier. */
  receivedThroughFrame: number;
  /** Largest accepted lead beyond the existing receive frontier. */
  maxFrameLead: number;
}

/**
 * Apply a decoded batch to keyed frame targets and advance the shared receive
 * frontier. The function is transport-neutral: consumers decode authentication,
 * packet headers, and payloads before calling it.
 */
export const applyFrameBatch = <K, V>({
  targets,
  entries,
  originFrame,
  receivedThroughFrame,
  maxFrameLead,
}: ApplyFrameBatchOptions<K, V>): AppliedFrameBatch<K, V> => {
  assertNonNegativeSafeInteger('originFrame', originFrame);
  assertNonNegativeSafeInteger('receivedThroughFrame', receivedThroughFrame);
  assertNonNegativeSafeInteger('maxFrameLead', maxFrameLead);
  for (const target of targets.values()) {
    assertNonNegativeSafeInteger('target.startFrame', target.startFrame);
    assertNonNegativeSafeInteger('target.confirmedHead', target.confirmedHead);
    if (target.confirmedHead < target.startFrame) {
      throw new Error('target.confirmedHead must be at or after startFrame');
    }
  }

  const acceptedEntries: AcceptedFrameBatchEntry<K, V>[] = [];
  const unknownTargetEntries: FrameBatchEntry<K, V>[] = [];
  const staleEntries: FrameBatchEntry<K, V>[] = [];
  const futureEntries: FrameBatchEntry<K, V>[] = [];
  const invalidEntries: FrameBatchEntry<K, V>[] = [];
  const rejectedEntries: FrameBatchEntry<K, V>[] = [];
  const maximumAcceptedFrame = Math.min(
    Number.MAX_SAFE_INTEGER,
    receivedThroughFrame + maxFrameLead
  );
  let committedFrame = false;

  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.frameOffset) || entry.frameOffset < 0) {
      invalidEntries.push(entry);
      continue;
    }

    const target = targets.get(entry.target);
    if (target === undefined) {
      unknownTargetEntries.push(entry);
      continue;
    }

    const localFrame = originFrame + entry.frameOffset;
    if (!Number.isSafeInteger(localFrame)) {
      invalidEntries.push(entry);
      continue;
    }

    if (localFrame < target.startFrame || localFrame < receivedThroughFrame) {
      staleEntries.push(entry);
      continue;
    }

    if (localFrame > maximumAcceptedFrame) {
      futureEntries.push(entry);
      continue;
    }

    const result = target.commit(localFrame, entry.value);
    if (result.kind === 'new' || result.kind === 'duplicate' || result.kind === 'corrected') {
      committedFrame = true;
      acceptedEntries.push({ entry, localFrame });
    } else {
      rejectedEntries.push(entry);
    }
  }

  let nextReceivedThroughFrame = receivedThroughFrame;
  if (committedFrame && targets.size > 0) {
    let minimumConfirmedHead = Number.POSITIVE_INFINITY;
    for (const target of targets.values()) {
      minimumConfirmedHead = Math.min(minimumConfirmedHead, target.confirmedHead);
    }
    nextReceivedThroughFrame = Math.max(receivedThroughFrame, minimumConfirmedHead);
  }

  return {
    receivedThroughFrame: nextReceivedThroughFrame,
    acceptedEntries,
    unknownTargetEntries,
    staleEntries,
    futureEntries,
    invalidEntries,
    rejectedEntries,
  };
};
