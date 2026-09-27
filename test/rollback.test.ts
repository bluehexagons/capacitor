import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

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
    assert.strictEqual(ring.load(2), 2);
    assert.strictEqual(restored, 12);
    assert.strictEqual(ring.refusalReason(1), 'missing-snapshot');
    ring.save(5, 20);
    assert.strictEqual(ring.refusalReason(2), 'out-of-window');
  });

  test('unsafe boundaries take precedence and clear resets metadata', () => {
    const ring = new RollbackRing<null, string>({
      createSnapshot: () => null,
      saveSnapshot: () => {},
      loadSnapshot: () => {},
    });
    ring.save(10);
    ring.markUnsafe(10, 'roster');
    assert.strictEqual(ring.refusalReason(10), 'unsafe-boundary');
    assert.deepStrictEqual(ring.unsafeReasons, ['roster']);
    ring.clear();
    assert.strictEqual(ring.unsafeSinceFrame, -1);
    assert.strictEqual(ring.peek(10), null);
  });
});

describe('RollbackCorrectionQueue', () => {
  test('drains to the earliest correction and retains deferred work', () => {
    const queue = new RollbackCorrectionQueue();
    const frames = [12, 8, 10];
    assert.strictEqual(
      queue.consumeEarliest(() => frames.shift() ?? null),
      8
    );
    queue.defer(14);
    queue.defer(11);
    assert.strictEqual(queue.deferred, 11);
    queue.clear(() => null);
    assert.strictEqual(queue.deferred, null);
  });
});
