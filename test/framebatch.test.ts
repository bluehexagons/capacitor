import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Client } from '../src/capacitor.js';
import {
  applyFrameBatch,
  collectFrameBatch,
  type FrameBatchEntry,
  type FrameSource,
  type FrameTarget,
} from '../src/framebatch.js';

type Input = { player: number; value: number };

const makeSource = (player: number, confirmedHead: number, startFrame = 0): FrameSource<Input> => ({
  baseFrame: startFrame,
  startFrame,
  confirmedHead,
  endFrame: Infinity,
  read: (frame) => (frame < confirmedHead && frame >= startFrame ? { player, value: frame } : null),
});

describe('collectFrameBatch', () => {
  test('collects confirmed values using offsets from the requested origin', () => {
    const batch = collectFrameBatch({
      sources: [makeSource(7, 12, 10)],
      originFrame: 10,
      throughFrame: 15,
      maxEntries: 255,
    });

    assert.strictEqual(batch.sentThroughFrame, 12);
    assert.deepStrictEqual(batch.entries, [
      { sourceIndex: 0, frame: 10, frameOffset: 0, value: { player: 7, value: 10 } },
      { sourceIndex: 0, frame: 11, frameOffset: 1, value: { player: 7, value: 11 } },
    ]);
  });

  test('shares the frame span fairly across sources', () => {
    const batch = collectFrameBatch({
      sources: [makeSource(1, 300), makeSource(2, 300)],
      originFrame: 0,
      throughFrame: 300,
      maxEntries: 255,
    });

    assert.strictEqual(batch.entries.length, 254);
    assert.strictEqual(batch.sentThroughFrame, 127);
    assert.strictEqual(batch.entries.filter((entry) => entry.sourceIndex === 0).length, 127);
    assert.strictEqual(batch.entries.filter((entry) => entry.sourceIndex === 1).length, 127);
  });

  test('advances shared progress only through the slowest source', () => {
    const batch = collectFrameBatch({
      sources: [makeSource(1, 5), makeSource(2, 2)],
      originFrame: 0,
      throughFrame: 5,
      maxEntries: 16,
    });

    assert.strictEqual(batch.sentThroughFrame, 2);
    assert.strictEqual(batch.entries.filter((entry) => entry.sourceIndex === 0).length, 5);
    assert.strictEqual(batch.entries.filter((entry) => entry.sourceIndex === 1).length, 2);
  });

  test('does not treat frames before a late source starts as discarded history', () => {
    const batch = collectFrameBatch({
      sources: [makeSource(1, 5), makeSource(2, 7, 5)],
      originFrame: 3,
      throughFrame: 7,
      maxEntries: 16,
    });

    assert.strictEqual(batch.sentThroughFrame, 5);
  });

  test('rejects an entry budget that cannot represent every participating source', () => {
    assert.throws(
      () =>
        collectFrameBatch({
          sources: Array.from({ length: 300 }, (_, player) => makeSource(player, 1)),
          originFrame: 0,
          throughFrame: 1,
          maxEntries: 255,
        }),
      (error) =>
        error instanceof Error &&
        error.message.includes('maxEntries must be at least the number of participating sources')
    );
  });

  test('completed sources do not constrain later progress', () => {
    const ended = new Client<Input>({});
    ended.commit(0, { player: 1, value: 0 });
    ended.deactivate(1);

    assert.deepStrictEqual(
      collectFrameBatch({
        sources: [ended],
        originFrame: 1,
        throughFrame: 4,
        maxEntries: 1,
      }),
      { entries: [], sentThroughFrame: 4 }
    );
  });

  test('respects a transport-specific frame span', () => {
    const batch = collectFrameBatch({
      sources: [makeSource(1, 20)],
      originFrame: 10,
      throughFrame: 20,
      maxEntries: 255,
      maxFrameSpan: 4,
    });

    assert.deepStrictEqual(
      batch.entries.map((entry) => entry.frameOffset),
      [0, 1, 2, 3]
    );
    assert.strictEqual(batch.sentThroughFrame, 14);
  });

  test('stops progress at a missing value below the confirmed head', () => {
    const batch = collectFrameBatch({
      sources: [
        {
          baseFrame: 5,
          startFrame: 5,
          confirmedHead: 8,
          endFrame: Infinity,
          read: (frame) => (frame === 6 ? null : { player: 1, value: frame }),
        },
      ],
      originFrame: 5,
      throughFrame: 8,
      maxEntries: 8,
    });

    assert.deepStrictEqual(
      batch.entries.map((entry) => entry.frame),
      [5]
    );
    assert.strictEqual(batch.sentThroughFrame, 6);
  });

  test('validates collection bounds', () => {
    assert.throws(
      () => collectFrameBatch({ sources: [], originFrame: 2, throughFrame: 1, maxEntries: 1 }),
      (error) =>
        error instanceof Error &&
        error.message.includes('throughFrame must be at or after originFrame')
    );
    assert.throws(
      () => collectFrameBatch({ sources: [], originFrame: 0, throughFrame: 1, maxEntries: 0 }),
      (error) =>
        error instanceof Error &&
        error.message.includes('maxEntries must be a positive safe integer')
    );
    assert.throws(
      () =>
        collectFrameBatch({
          sources: [
            { baseFrame: 2, startFrame: 2, confirmedHead: 1, endFrame: Infinity, read: () => null },
          ],
          originFrame: 0,
          throughFrame: 1,
          maxEntries: 1,
        }),
      (error) =>
        error instanceof Error &&
        error.message.includes('confirmedHead must be at or after startFrame')
    );
    assert.throws(
      () =>
        collectFrameBatch({
          sources: [
            { baseFrame: 2, startFrame: 0, confirmedHead: 1, endFrame: Infinity, read: () => null },
          ],
          originFrame: 2,
          throughFrame: 3,
          maxEntries: 1,
        }),
      (error) =>
        error instanceof Error &&
        error.message.includes('confirmedHead must be at or after baseFrame')
    );
  });

  test('fails closed when the requested origin has fallen out of history', () => {
    const source = new Client<Input>({ historyFrames: 4 });
    for (let frame = 0; frame < 6; frame++) {
      source.commit(frame, { player: 1, value: frame });
    }

    assert.throws(
      () =>
        collectFrameBatch({
          sources: [source],
          originFrame: 0,
          throughFrame: 6,
          maxEntries: 8,
        }),
      (error) => error instanceof Error && error.message.includes('no longer retains originFrame')
    );
  });
});

describe('applyFrameBatch', () => {
  const entry = (
    target: number,
    frameOffset: number,
    value = frameOffset
  ): FrameBatchEntry<number, Input> => ({
    target,
    frameOffset,
    value: { player: target, value },
  });

  test('commits decoded values and advances the shared confirmed frontier', () => {
    const first = new Client<Input>({ startFrame: 10 });
    const second = new Client<Input>({ startFrame: 10 });
    second.commit(10, { player: 2, value: 10 });
    second.commit(11, { player: 2, value: 11 });

    const applied = applyFrameBatch({
      targets: new Map<number, FrameTarget<Input>>([
        [1, first],
        [2, second],
      ]),
      entries: [entry(1, 0, 10), entry(1, 1, 11)],
      originFrame: 10,
      receivedThroughFrame: 10,
      maxFrameLead: 255,
    });

    assert.strictEqual(applied.receivedThroughFrame, 12);
    assert.deepStrictEqual(
      applied.acceptedEntries.map((item) => item.localFrame),
      [10, 11]
    );
    assert.deepStrictEqual(first.read(10), { player: 1, value: 10 });
    assert.deepStrictEqual(first.read(11), { player: 1, value: 11 });
  });

  test('classifies unknown, stale, future, invalid, and target-rejected entries', () => {
    const target = new Client<Input>({ startFrame: 10, historyFrames: 4 });
    const rejectingTarget = {
      baseFrame: 10,
      capacity: 4,
      endFrame: Infinity,
      startFrame: 10,
      confirmedHead: 10,
      commit: () => ({ kind: 'inactive' as const }),
    };
    const entries = [entry(9, 0), entry(1, 0), entry(1, 10), entry(1, -1), entry(2, 2)];

    const applied = applyFrameBatch({
      targets: new Map<number, FrameTarget<Input>>([
        [1, target],
        [2, rejectingTarget],
      ]),
      entries,
      originFrame: 8,
      receivedThroughFrame: 10,
      maxFrameLead: 4,
    });

    assert.deepStrictEqual(applied.unknownTargetEntries, [entries[0]]);
    assert.deepStrictEqual(applied.staleEntries, [entries[1]]);
    assert.deepStrictEqual(applied.futureEntries, [entries[2]]);
    assert.deepStrictEqual(applied.invalidEntries, [entries[3]]);
    assert.deepStrictEqual(applied.rejectedEntries, [entries[4]]);
    assert.strictEqual(applied.receivedThroughFrame, 10);
  });

  test('accepts idempotent duplicates and rollback corrections', () => {
    const target = new Client<Input>({
      startFrame: 0,
      comparator: (left, right) => left.player === right.player && left.value === right.value,
      predictor: (previous) => previous,
    });
    target.commit(0, { player: 1, value: 0 });
    target.predict(1, { player: 1, value: 0 });

    const duplicate = applyFrameBatch({
      targets: new Map([[1, target]]),
      entries: [entry(1, 0, 0)],
      originFrame: 0,
      receivedThroughFrame: 0,
      maxFrameLead: 8,
    });
    const correction = applyFrameBatch({
      targets: new Map([[1, target]]),
      entries: [entry(1, 1, 1)],
      originFrame: 0,
      receivedThroughFrame: 1,
      maxFrameLead: 8,
    });

    assert.strictEqual(duplicate.acceptedEntries.length, 1);
    assert.strictEqual(correction.acceptedEntries.length, 1);
    assert.strictEqual(correction.receivedThroughFrame, 2);
    assert.strictEqual(target.consumeDirty(), 1);
  });

  test('classifies immutable confirmed-input conflicts separately', () => {
    const target = new Client<Input>({
      comparator: (left, right) => left.player === right.player && left.value === right.value,
    });
    target.commit(0, { player: 1, value: 1 });

    const applied = applyFrameBatch({
      targets: new Map([[1, target]]),
      entries: [entry(1, 0, 2)],
      originFrame: 0,
      receivedThroughFrame: 0,
      maxFrameLead: 8,
    });

    assert.deepStrictEqual(applied.conflictEntries, [
      { entry: entry(1, 0, 2), localFrame: 0, rollbackFrame: 0 },
    ]);
    assert.deepStrictEqual(applied.acceptedEntries, []);
    assert.deepStrictEqual(applied.rejectedEntries, []);
    assert.deepStrictEqual(target.read(0), { player: 1, value: 1 });
  });

  test('does not advance across a gap in any target', () => {
    let confirmedHead = 10;
    const target: FrameTarget<Input> = {
      baseFrame: 10,
      capacity: 16,
      endFrame: Infinity,
      startFrame: 10,
      get confirmedHead() {
        return confirmedHead;
      },
      commit: (frame) => {
        if (frame !== confirmedHead) return { kind: 'stale' };
        confirmedHead++;
        return { kind: 'new' };
      },
    };
    const applied = applyFrameBatch({
      targets: new Map([[1, target]]),
      entries: [entry(1, 1, 11), entry(1, 0, 10), entry(1, 0, 10)],
      originFrame: 10,
      receivedThroughFrame: 10,
      maxFrameLead: 8,
    });

    assert.strictEqual(applied.receivedThroughFrame, 11);
    assert.strictEqual(applied.acceptedEntries.length, 1);
    assert.deepStrictEqual(applied.rejectedEntries, [entry(1, 1, 11), entry(1, 0, 10)]);
  });

  test('advances across an evicted confirmed prefix and classifies it as stale', () => {
    let confirmedHead = 25;
    const target: FrameTarget<Input> = {
      baseFrame: 20,
      capacity: 16,
      endFrame: Infinity,
      startFrame: 10,
      get confirmedHead() {
        return confirmedHead;
      },
      commit: (frame) => {
        if (frame !== confirmedHead) return { kind: 'stale' };
        confirmedHead++;
        return { kind: 'new' };
      },
    };
    const applied = applyFrameBatch({
      targets: new Map([[1, target]]),
      entries: [entry(1, 5, 15), entry(1, 15, 25)],
      originFrame: 10,
      receivedThroughFrame: 10,
      maxFrameLead: 20,
    });

    assert.deepStrictEqual(applied.staleEntries, [entry(1, 5, 15)]);
    assert.deepStrictEqual(applied.acceptedEntries, [{ entry: entry(1, 15, 25), localFrame: 25 }]);
    assert.strictEqual(applied.receivedThroughFrame, 26);
  });

  test('rejects input that would evict unresolved retained history', () => {
    const target = new Client<Input>({ historyFrames: 4 });
    const applied = applyFrameBatch({
      targets: new Map([[1, target]]),
      entries: [entry(1, 4, 4)],
      originFrame: 0,
      receivedThroughFrame: 0,
      maxFrameLead: 8,
    });

    assert.deepStrictEqual(applied.futureEntries, [entry(1, 4, 4)]);
    assert.strictEqual(target.baseFrame, 0);
    assert.strictEqual(applied.receivedThroughFrame, 0);
  });

  test('recomputes progress for empty batches and ignores completed targets', () => {
    const live = new Client<Input>({});
    live.commit(0, { player: 1, value: 0 });
    live.commit(1, { player: 1, value: 1 });
    const ended = new Client<Input>({});
    ended.commit(0, { player: 2, value: 0 });
    ended.deactivate(1);

    const applied = applyFrameBatch({
      targets: new Map([
        [1, live],
        [2, ended],
      ]),
      entries: [],
      originFrame: 0,
      receivedThroughFrame: 0,
      maxFrameLead: 8,
    });

    assert.strictEqual(applied.receivedThroughFrame, 2);
  });

  test('validates application coordinates', () => {
    assert.throws(
      () =>
        applyFrameBatch({
          targets: new Map(),
          entries: [],
          originFrame: -1,
          receivedThroughFrame: 0,
          maxFrameLead: 0,
        }),
      (error) =>
        error instanceof Error &&
        error.message.includes('originFrame must be a non-negative safe integer')
    );
  });
});
