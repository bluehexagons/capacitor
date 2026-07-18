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
  startFrame,
  confirmedHead,
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

    expect(batch.sentThroughFrame).toBe(12);
    expect(batch.entries).toEqual([
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

    expect(batch.entries).toHaveLength(254);
    expect(batch.sentThroughFrame).toBe(127);
    expect(batch.entries.filter((entry) => entry.sourceIndex === 0)).toHaveLength(127);
    expect(batch.entries.filter((entry) => entry.sourceIndex === 1)).toHaveLength(127);
  });

  test('bounds total entries when there are more sources than slots', () => {
    const batch = collectFrameBatch({
      sources: Array.from({ length: 300 }, (_, player) => makeSource(player, 1)),
      originFrame: 0,
      throughFrame: 1,
      maxEntries: 255,
    });

    expect(batch.entries).toHaveLength(255);
    expect(batch.sentThroughFrame).toBe(1);
  });

  test('respects a transport-specific frame span', () => {
    const batch = collectFrameBatch({
      sources: [makeSource(1, 20)],
      originFrame: 10,
      throughFrame: 20,
      maxEntries: 255,
      maxFrameSpan: 4,
    });

    expect(batch.entries.map((entry) => entry.frameOffset)).toEqual([0, 1, 2, 3]);
    expect(batch.sentThroughFrame).toBe(14);
  });

  test('skips missing source values without fabricating frames', () => {
    const batch = collectFrameBatch({
      sources: [
        {
          startFrame: 5,
          confirmedHead: 8,
          read: (frame) => (frame === 6 ? null : { player: 1, value: frame }),
        },
      ],
      originFrame: 5,
      throughFrame: 8,
      maxEntries: 8,
    });

    expect(batch.entries.map((entry) => entry.frame)).toEqual([5, 7]);
    expect(batch.sentThroughFrame).toBe(8);
  });

  test('validates collection bounds', () => {
    expect(() =>
      collectFrameBatch({ sources: [], originFrame: 2, throughFrame: 1, maxEntries: 1 })
    ).toThrow('throughFrame must be at or after originFrame');
    expect(() =>
      collectFrameBatch({ sources: [], originFrame: 0, throughFrame: 1, maxEntries: 0 })
    ).toThrow('maxEntries must be a positive safe integer');
    expect(() =>
      collectFrameBatch({
        sources: [{ startFrame: 2, confirmedHead: 1, read: () => null }],
        originFrame: 0,
        throughFrame: 1,
        maxEntries: 1,
      })
    ).toThrow('confirmedHead must be at or after startFrame');
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

    expect(applied.receivedThroughFrame).toBe(12);
    expect(applied.acceptedEntries.map((item) => item.localFrame)).toEqual([10, 11]);
    expect(first.read(10)).toEqual({ player: 1, value: 10 });
    expect(first.read(11)).toEqual({ player: 1, value: 11 });
  });

  test('classifies unknown, stale, future, invalid, and target-rejected entries', () => {
    const target = new Client<Input>({ startFrame: 10, historyFrames: 4 });
    const rejectingTarget = {
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

    expect(applied.unknownTargetEntries).toEqual([entries[0]]);
    expect(applied.staleEntries).toEqual([entries[1]]);
    expect(applied.futureEntries).toEqual([entries[2]]);
    expect(applied.invalidEntries).toEqual([entries[3]]);
    expect(applied.rejectedEntries).toEqual([entries[4]]);
    expect(applied.receivedThroughFrame).toBe(10);
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

    expect(duplicate.acceptedEntries).toHaveLength(1);
    expect(correction.acceptedEntries).toHaveLength(1);
    expect(correction.receivedThroughFrame).toBe(2);
    expect(target.consumeDirty()).toBe(1);
  });

  test('does not advance across a gap in any target', () => {
    let confirmedHead = 10;
    const target: FrameTarget<Input> = {
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

    expect(applied.receivedThroughFrame).toBe(11);
    expect(applied.acceptedEntries).toHaveLength(1);
    expect(applied.rejectedEntries).toEqual([entry(1, 1, 11), entry(1, 0, 10)]);
  });

  test('validates application coordinates', () => {
    expect(() =>
      applyFrameBatch({
        targets: new Map(),
        entries: [],
        originFrame: -1,
        receivedThroughFrame: 0,
        maxFrameLead: 0,
      })
    ).toThrow('originFrame must be a non-negative safe integer');
  });
});
