import { RollbackCorrectionQueue, RollbackRing } from '../src/rollback.js';

describe('RollbackRing', () => {
  test('stores, restores, overwrites, and classifies snapshots', () => {
    let restored = -1;
    const ring = new RollbackRing<{ value: number }, string, [number]>({
      window: 3,
      createSnapshot: () => ({ value: -1 }),
      saveSnapshot: (snapshot, frame, value) => {
        snapshot.value = value + frame;
      },
      loadSnapshot: (snapshot) => {
        restored = snapshot.value;
      },
    });

    ring.save(2, 10);
    expect(ring.load(2)).toBe(2);
    expect(restored).toBe(12);
    expect(ring.refusalReason(1)).toBe('missing-snapshot');
    ring.save(5, 20);
    expect(ring.refusalReason(2)).toBe('out-of-window');
  });

  test('unsafe boundaries take precedence and clear resets metadata', () => {
    const ring = new RollbackRing<null, string>({
      createSnapshot: () => null,
      saveSnapshot: () => {},
      loadSnapshot: () => {},
    });
    ring.save(10);
    ring.markUnsafe(10, 'roster');
    expect(ring.refusalReason(10)).toBe('unsafe-boundary');
    expect(ring.unsafeReasons).toEqual(['roster']);
    ring.clear();
    expect(ring.unsafeSinceFrame).toBe(-1);
    expect(ring.peek(10)).toBe(null);
  });
});

describe('RollbackCorrectionQueue', () => {
  test('drains to the earliest correction and retains deferred work', () => {
    const queue = new RollbackCorrectionQueue();
    const frames = [12, 8, 10];
    expect(queue.consumeEarliest(() => frames.shift() ?? null)).toBe(8);
    queue.defer(14);
    queue.defer(11);
    expect(queue.deferred).toBe(11);
    queue.clear(() => null);
    expect(queue.deferred).toBe(null);
  });
});
