import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Capacitor, Client } from '../src/capacitor.js';

interface Packet {
  value: number;
}

const compare = (a: Packet, b: Packet) => a.value === b.value;

describe('Client', () => {
  test('first commit reports new, idempotent retransmit reports duplicate', () => {
    const cap = new Capacitor<Packet>(compare);
    const client = cap.connect({});
    assert.strictEqual(client.read(0), null);
    assert.strictEqual(client.size, 0);

    assert.strictEqual(client.commit(0, { value: 0 }).kind, 'new');
    assert.strictEqual(client.read(0)?.value, 0);

    // Confirmed input is immutable by default.
    const corrected = client.commit(0, { value: 1 });
    assert.strictEqual(corrected.kind, 'conflict');
    if (corrected.kind === 'conflict') assert.strictEqual(corrected.rollbackFrame, 0);
    assert.strictEqual(client.read(0)?.value, 0);

    assert.strictEqual(client.commit(0, { value: 0 }).kind, 'duplicate');
  });

  test('confirmed conflicts can opt into legacy replacement behavior', () => {
    const client = new Client<Packet>({ comparator: compare, confirmedConflict: 'replace' });
    client.commit(0, { value: 0 });
    assert.strictEqual(client.commit(0, { value: 1 }).kind, 'corrected');
    assert.strictEqual(client.read(0)?.value, 1);
    assert.strictEqual(client.consumeDirty(), 0);
  });

  test('non-contiguous commits do not advance confirmedHead', () => {
    const cap = new Capacitor<Packet>(compare);
    const client = cap.connect({});
    assert.strictEqual(client.commit(0, { value: 0 }).kind, 'new');
    assert.strictEqual(client.commit(1, { value: 0 }).kind, 'new');
    assert.strictEqual(client.size, 2);

    // Skip frame 2; head should not move past 2.
    assert.strictEqual(client.commit(4, { value: 4 }).kind, 'new');
    assert.strictEqual(client.read(2), null);
    assert.strictEqual(client.size, 2);

    // Filling the gap brings head all the way up.
    assert.strictEqual(client.commit(3, { value: 3 }).kind, 'new');
    assert.strictEqual(client.commit(2, { value: 2 }).kind, 'new');
    assert.strictEqual(client.size, 5);
    assert.strictEqual(client.read(2)?.value, 2);
    assert.strictEqual(client.read(4)?.value, 4);
  });

  test('startFrame rejects earlier commits as stale', () => {
    const cap = new Capacitor<Packet>(compare);
    const client = cap.connect({ startFrame: 5 });
    assert.strictEqual(client.startFrame, 5);
    assert.strictEqual(client.sizeOffset, 5);

    assert.strictEqual(client.commit(4, { value: 4 }).kind, 'stale');
    assert.strictEqual(client.size, 0);
    assert.strictEqual(client.read(4), null);

    assert.strictEqual(client.commit(5, { value: 5 }).kind, 'new');
    assert.strictEqual(client.read(5)?.value, 5);

    assert.strictEqual(client.commit(6, { value: 6 }).kind, 'new');
    assert.strictEqual(client.read(6)?.value, 6);
    assert.strictEqual(client.size, 2);
  });

  test('predict then matching confirm reports duplicate, mismatching confirm reports corrected', () => {
    const cap = new Capacitor<Packet>(compare);
    const client = cap.connect({});
    assert.strictEqual(client.predict(0, { value: 9 }).kind, 'new');
    assert.strictEqual(client.frameStatus(0), 'predicted');

    // Match: prediction confirmed without rollback.
    assert.strictEqual(client.commit(0, { value: 9 }).kind, 'duplicate');
    assert.strictEqual(client.frameStatus(0), 'confirmed');
    assert.strictEqual(client.consumeDirty(), null);

    // Mismatch: prediction was wrong; rollback frame surfaces.
    assert.strictEqual(client.predict(1, { value: 1 }).kind, 'new');
    const result = client.commit(1, { value: 2 });
    assert.strictEqual(result.kind, 'corrected');
    if (result.kind === 'corrected') assert.strictEqual(result.rollbackFrame, 1);
    assert.strictEqual(client.consumeDirty(), 1);
    assert.strictEqual(client.consumeDirty(), null);
  });

  test('predict cannot downgrade or create rollback against confirmed input', () => {
    const cap = new Capacitor<Packet>(compare);
    const client = cap.connect({});
    assert.strictEqual(client.commit(0, { value: 5 }).kind, 'new');
    assert.strictEqual(client.predict(0, { value: 5 }).kind, 'duplicate');
    assert.strictEqual(client.predict(0, { value: 9 }).kind, 'duplicate');
    assert.strictEqual(client.frameStatus(0), 'confirmed');
    assert.strictEqual(client.read(0)?.value, 5);
    assert.strictEqual(client.consumeDirty(), null);
  });

  test('history bound trims oldest entries on overflow', () => {
    const cap = new Capacitor<Packet>(compare);
    const client = cap.connect({ historyFrames: 4 });
    for (let i = 0; i < 6; i++) {
      assert.strictEqual(client.commit(i, { value: i }).kind, 'new');
    }
    assert.strictEqual(client.read(0), null); // trimmed
    assert.strictEqual(client.read(1), null); // trimmed
    assert.strictEqual(client.read(2)?.value, 2);
    assert.strictEqual(client.read(5)?.value, 5);

    // A re-commit landing in the trimmed region is rejected.
    assert.strictEqual(client.commit(0, { value: 0 }).kind, 'outside-window');
  });

  test('sparse writes beyond the window remain readable without aliasing the confirmed head', () => {
    const cap = new Capacitor<Packet>(compare);
    const client = cap.connect({ historyFrames: 4 });

    assert.strictEqual(client.commit(100, { value: 100 }).kind, 'new');
    assert.strictEqual(client.baseFrame, 97);
    assert.strictEqual(client.confirmedHead, 97);
    assert.strictEqual(client.read(100)?.value, 100);

    assert.strictEqual(client.commit(101, { value: 101 }).kind, 'new');
    assert.strictEqual(client.baseFrame, 98);
    assert.strictEqual(client.read(100)?.value, 100);
    assert.strictEqual(client.read(101)?.value, 101);

    // Filling the retained gap advances through both sparse commits.
    client.commit(98, { value: 98 });
    client.commit(99, { value: 99 });
    assert.strictEqual(client.confirmedHead, 102);
  });

  test('constructor and mutating APIs reject non-integral frame coordinates', () => {
    assert.throws(
      () => new Client({ historyFrames: 1.5 }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          'historyFrames must be a positive safe integer within the maximum array length'
        )
    );
    assert.throws(
      () => new Client({ startFrame: -1 }),
      (error) =>
        error instanceof Error &&
        error.message.includes('frame must be a non-negative safe integer')
    );
    assert.throws(
      () => new Client({ startFrame: Number.NaN }),
      (error) =>
        error instanceof Error &&
        error.message.includes('frame must be a non-negative safe integer')
    );
    assert.throws(
      () => new Client({ startFrame: 1, sizeOffset: 2 }),
      (error) =>
        error instanceof Error &&
        error.message.includes('startFrame and sizeOffset must match when both are provided')
    );

    const client = new Client<Packet>({ comparator: compare });
    assert.throws(
      () => client.commit(Number.NaN, { value: 0 }),
      (error) => error instanceof Error && error.message.includes('frame must be a safe integer')
    );
    assert.throws(
      () => client.predict(1.5, { value: 0 }),
      (error) => error instanceof Error && error.message.includes('frame must be a safe integer')
    );
    assert.throws(
      () => client.deactivate(Infinity),
      (error) =>
        error instanceof Error &&
        error.message.includes('frame must be a non-negative safe integer')
    );

    const cap = new Capacitor<Packet>(compare);
    assert.throws(
      () => cap.readConfirmed(Number.NaN),
      (error) => error instanceof Error && error.message.includes('frame must be a safe integer')
    );
    assert.throws(
      () => cap.resync(-1),
      (error) =>
        error instanceof Error &&
        error.message.includes('frame must be a non-negative safe integer')
    );
  });

  test('direct Client construction uses identity comparison by default', () => {
    const client = new Client<number>({});

    client.commit(0, 1);
    assert.strictEqual(client.commit(0, 1).kind, 'duplicate');
    assert.strictEqual(client.commit(0, 2).kind, 'conflict');
  });

  test('Capacitor.connect always uses the shared comparator', () => {
    const cap = new Capacitor<Packet>(compare);
    // A non-literal object can still carry an extra runtime property even
    // though CapacitorClientProps excludes it from the public type.
    const props = { historyFrames: 4, comparator: () => true };
    const client = cap.connect(props);

    client.commit(0, { value: 1 });
    assert.strictEqual(client.commit(0, { value: 2 }).kind, 'conflict');
  });

  test('trimBefore advances baseFrame and clears slots', () => {
    const cap = new Capacitor<Packet>(compare);
    const client = cap.connect({});
    for (let i = 0; i < 5; i++) client.commit(i, { value: i });
    client.trimBefore(3);
    assert.strictEqual(client.read(2), null);
    assert.strictEqual(client.read(3)?.value, 3);
  });

  test('window advancement recovers a confirmed head at the new base', () => {
    const client = new Client<Packet>({ comparator: compare, historyFrames: 4 });
    client.commit(2, { value: 2 });

    client.predict(4, { value: 4 });
    client.predict(5, { value: 5 });

    assert.strictEqual(client.baseFrame, 2);
    assert.strictEqual(client.confirmedHead, 3);
  });

  test('deactivate stops accepting commits at endFrame', () => {
    const cap = new Capacitor<Packet>(compare);
    const client = cap.connect({});
    client.commit(0, { value: 0 });
    client.deactivate(2);
    assert.strictEqual(client.commit(2, { value: 2 }).kind, 'inactive');
    assert.strictEqual(client.commit(1, { value: 1 }).kind, 'new');

    // Repeated calls can shorten participation but cannot reactivate it.
    client.deactivate(5);
    assert.strictEqual(client.endFrame, 2);
  });

  test('ensurePredicted fills empty slots with the predictor strategy', () => {
    const cap = new Capacitor<Packet>(compare);
    const client = cap.connect({
      predictor: (prev) => (prev !== null ? { value: prev.value } : null), // repeat last input
    });
    client.commit(0, { value: 7 });
    client.ensurePredicted(4);
    assert.strictEqual(client.frameStatus(1), 'predicted');
    assert.strictEqual(client.frameStatus(4), 'predicted');
    assert.strictEqual(client.read(4)?.value, 7);
    assert.strictEqual(client.confirmedHead, 1); // predictions don't advance confirmedHead
  });

  test('ensurePredicted extends beyond one ring capacity without slot aliasing', () => {
    const cap = new Capacitor<Packet>(compare);
    const client = cap.connect({
      historyFrames: 4,
      predictor: (prev) => ({ value: (prev?.value ?? -1) + 1 }),
    });

    client.ensurePredicted(10);

    assert.strictEqual(client.baseFrame, 7);
    assert.strictEqual(client.read(6), null);
    assert.strictEqual(client.read(7)?.value, 7);
    assert.strictEqual(client.read(10)?.value, 10);
    assert.strictEqual(client.frameStatus(10), 'predicted');
  });

  test('ensurePredicted is a no-op when no predictor is configured', () => {
    const cap = new Capacitor<Packet>(compare);
    const noPredictor = cap.connect({});
    noPredictor.commit(0, { value: 1 });
    noPredictor.ensurePredicted(5);
    assert.strictEqual(noPredictor.frameStatus(1), 'empty');

    // A predictor that propagates null prev (passthrough) effectively
    // refuses cold-start fills — slots without an anchor stay empty.
    const passThrough = cap.connect({ predictor: (prev) => prev });
    passThrough.ensurePredicted(5);
    assert.strictEqual(passThrough.frameStatus(0), 'empty');
  });

  test('matching commit upgrades a prediction without rollback', () => {
    const cap = new Capacitor<Packet>(compare);
    const client = cap.connect({ predictor: (prev) => prev });
    client.commit(0, { value: 3 });
    client.ensurePredicted(2);
    assert.strictEqual(client.frameStatus(1), 'predicted');

    assert.strictEqual(client.commit(1, { value: 3 }).kind, 'duplicate');
    assert.strictEqual(client.frameStatus(1), 'confirmed');
    assert.strictEqual(client.confirmedHead, 2);
    assert.strictEqual(client.consumeDirty(), null);

    // Frame 2 prediction disagrees with the wire input → correction.
    const result = client.commit(2, { value: 99 });
    assert.strictEqual(result.kind, 'corrected');
    assert.strictEqual(client.consumeDirty(), 2);
  });

  test('ensurePredicted leaves already-written slots alone', () => {
    const cap = new Capacitor<Packet>(compare);
    const client = cap.connect({
      predictor: (prev) => (prev !== null ? { value: prev.value + 1 } : null),
    });
    client.commit(0, { value: 0 });
    // Land a confirmed value mid-stream as well.
    client.commit(3, { value: 42 });
    client.ensurePredicted(5);
    assert.strictEqual(client.read(3)?.value, 42); // confirmed value preserved
    assert.strictEqual(client.read(1)?.value, 1);
    assert.strictEqual(client.read(2)?.value, 2);
    // After the confirmed gap, predictions resume from the confirmed value.
    assert.strictEqual(client.read(4)?.value, 43);
    assert.strictEqual(client.read(5)?.value, 44);
  });

  test('invalidatePredictedFrom drops predictions and lets ensurePredicted recompute', () => {
    const cap = new Capacitor<Packet>(compare);
    const client = cap.connect({
      predictor: (prev) => (prev !== null ? { value: prev.value + 1 } : null),
    });
    client.commit(0, { value: 0 });
    client.ensurePredicted(5);
    // Predictions: 1..5 derived from anchor 0.
    assert.strictEqual(client.read(5)?.value, 5);
    // A late-arriving confirmed correction at frame 2 invalidates 3..5.
    const result = client.commit(2, { value: 100 });
    assert.strictEqual(result.kind, 'corrected');
    const cleared = client.invalidatePredictedFrom(3);
    assert.strictEqual(cleared, 3);
    assert.strictEqual(client.frameStatus(3), 'empty');
    assert.strictEqual(client.frameStatus(5), 'empty');
    // Confirmed slots are preserved.
    assert.strictEqual(client.read(2)?.value, 100);
    // Re-running ensurePredicted now anchors on the corrected value.
    client.ensurePredicted(5);
    assert.strictEqual(client.read(3)?.value, 101);
    assert.strictEqual(client.read(5)?.value, 103);
  });

  test('invalidatePredictedFrom preserves confirmed slots after the boundary', () => {
    const cap = new Capacitor<Packet>(compare);
    const client = cap.connect({
      predictor: (prev) => (prev !== null ? { value: prev.value + 1 } : null),
    });
    client.commit(0, { value: 0 });
    client.predict(1, { value: 11 });
    client.commit(2, { value: 22 });
    client.predict(3, { value: 33 });
    client.invalidatePredictedFrom(1);
    assert.strictEqual(client.frameStatus(1), 'empty');
    assert.strictEqual(client.frameStatus(2), 'confirmed');
    assert.strictEqual(client.read(2)?.value, 22);
    assert.strictEqual(client.frameStatus(3), 'empty');
  });

  test('Capacitor.invalidatePredictedFrom delegates to every client', () => {
    const cap = new Capacitor<Packet>(compare);
    const a = cap.connect({
      predictor: (prev) => (prev !== null ? { value: prev.value + 1 } : null),
    });
    const b = cap.connect({
      predictor: (prev) => (prev !== null ? { value: prev.value + 10 } : null),
    });
    a.commit(0, { value: 0 });
    b.commit(0, { value: 0 });
    cap.ensurePredicted(3);
    cap.invalidatePredictedFrom(1);
    assert.strictEqual(a.frameStatus(1), 'empty');
    assert.strictEqual(b.frameStatus(1), 'empty');
  });

  test('resync clears buffered values and re-anchors the same client object', () => {
    const cap = new Capacitor<Packet>(compare);
    const client = cap.connect({
      predictor: (prev) => (prev !== null ? { value: prev.value + 1 } : null),
    });

    client.commit(0, { value: 0 });
    client.ensurePredicted(4);
    const corrected = client.commit(2, { value: 20 });
    assert.strictEqual(corrected.kind, 'corrected');

    client.resync(10);

    assert.strictEqual(client.startFrame, 10);
    assert.strictEqual(client.sizeOffset, 10);
    assert.strictEqual(client.size, 0);
    assert.strictEqual(client.read(0), null);
    assert.strictEqual(client.read(4), null);
    assert.strictEqual(client.read(10), null);
    assert.strictEqual(client.consumeDirty(), null);
    assert.strictEqual(client.commit(9, { value: 9 }).kind, 'stale');
    assert.strictEqual(client.commit(10, { value: 10 }).kind, 'new');
    assert.strictEqual(client.read(10)?.value, 10);
  });

  test('Capacitor.resync preserves client references while clearing all clients', () => {
    const cap = new Capacitor<Packet>(compare);
    const a = cap.connect({});
    const b = cap.connect({});

    a.commit(0, { value: 1 });
    b.commit(0, { value: 2 });
    cap.resync(7);

    assert.strictEqual(cap.clients.has(a), true);
    assert.strictEqual(cap.clients.has(b), true);
    assert.strictEqual(a.sizeOffset, 7);
    assert.strictEqual(b.sizeOffset, 7);
    assert.strictEqual(cap.readConfirmed(7), false);

    a.commit(7, { value: 17 });
    b.commit(7, { value: 27 });
    assert.strictEqual(cap.readConfirmed(7), true);
    assert.strictEqual(a.cache?.value, 17);
    assert.strictEqual(b.cache?.value, 27);
  });

  test('hasValue reports confirmed and predicted but not empty / out-of-window', () => {
    const cap = new Capacitor<Packet>(compare);
    const client = cap.connect({ startFrame: 5 });

    assert.strictEqual(client.hasValue(4), false); // before startFrame
    assert.strictEqual(client.hasValue(5), false); // empty
    client.commit(5, { value: 5 });
    assert.strictEqual(client.hasValue(5), true);
    client.predict(6, { value: 6 });
    assert.strictEqual(client.hasValue(6), true);

    client.deactivate(7);
    client.commit(7, { value: 7 }); // ignored (inactive)
    assert.strictEqual(client.hasValue(7), false);
  });

  test('commitIfEmpty fills empty slots and refuses to clobber existing values', () => {
    const cap = new Capacitor<Packet>(compare);
    const client = cap.connect({});

    // First commitIfEmpty wins, advances the confirmed head.
    assert.strictEqual(client.commitIfEmpty(0, { value: 0 }).kind, 'new');
    assert.strictEqual(client.frameStatus(0), 'confirmed');
    assert.strictEqual(client.read(0)?.value, 0);
    assert.strictEqual(client.size, 1);

    // A second commitIfEmpty at the same slot is a duplicate even with a
    // different value — the existing confirmed value is preserved.
    assert.strictEqual(client.commitIfEmpty(0, { value: 99 }).kind, 'duplicate');
    assert.strictEqual(client.read(0)?.value, 0);

    // commitIfEmpty also refuses to overwrite predictions.
    client.predict(1, { value: 11 });
    assert.strictEqual(client.commitIfEmpty(1, { value: 22 }).kind, 'duplicate');
    assert.strictEqual(client.frameStatus(1), 'predicted');
    assert.strictEqual(client.read(1)?.value, 11);

    // Window edges report the same kinds as commit.
    assert.strictEqual(client.commitIfEmpty(-1, { value: -1 }).kind, 'stale');
    client.deactivate(5);
    assert.strictEqual(client.commitIfEmpty(5, { value: 5 }).kind, 'inactive');
  });

  test('commitIfEmpty advances confirmed head across a contiguous fill', () => {
    const cap = new Capacitor<Packet>(compare);
    const client = cap.connect({});

    // Sparse base: leave a gap at frame 1.
    client.commit(0, { value: 0 });
    client.commit(2, { value: 2 });
    assert.strictEqual(client.confirmedHead, 1);

    // commitIfEmpty fills the gap; head walks past the existing confirmed
    // slot at frame 2.
    assert.strictEqual(client.commitIfEmpty(1, { value: 1 }).kind, 'new');
    assert.strictEqual(client.confirmedHead, 3);
    assert.strictEqual(client.read(1)?.value, 1);
    assert.strictEqual(client.read(2)?.value, 2);
  });

  test('null-tolerant predictor synthesizes cold-start values', () => {
    const cap = new Capacitor<Packet>(compare);
    // Cold-start predictor: produces 0 when there is no anchor, then
    // repeats the prior value.
    const client = cap.connect({ predictor: (prev) => (prev !== null ? prev : { value: 0 }) });

    // No prior commit at all — ensurePredicted should still fill.
    client.ensurePredicted(2);
    assert.strictEqual(client.frameStatus(0), 'predicted');
    assert.strictEqual(client.frameStatus(1), 'predicted');
    assert.strictEqual(client.frameStatus(2), 'predicted');
    assert.strictEqual(client.read(0)?.value, 0);
    assert.strictEqual(client.read(2)?.value, 0);
  });

  test('predictor returning null halts prediction without writing the slot', () => {
    const cap = new Capacitor<Packet>(compare);
    const client = cap.connect({ predictor: () => null });

    client.ensurePredicted(3);
    assert.strictEqual(client.frameStatus(0), 'empty');
    assert.strictEqual(client.frameStatus(3), 'empty');
    assert.strictEqual(client.writtenHead, 0);
  });
});

describe('Capacitor lockstep helpers', () => {
  test('readConfirmed only returns true once every client has a confirmed value', () => {
    const cap = new Capacitor<Packet>(compare);
    const client = cap.connect({});

    assert.strictEqual(cap.readConfirmed(0), false);
    const initialCache = client.cache;
    assert.strictEqual(initialCache, null);

    client.commit(1, { value: 0 });
    assert.strictEqual(cap.readConfirmed(0), false);

    client.commit(0, { value: 1 });
    assert.strictEqual(cap.readConfirmed(0), true);
    assert.strictEqual(client.cache?.value, 1);

    assert.strictEqual(cap.readConfirmed(1), true);
    assert.strictEqual(client.cache?.value, 0);

    assert.strictEqual(cap.readConfirmed(2), false);
  });

  test('predicted values do not satisfy readConfirmed but do satisfy readDetailed.complete', () => {
    const cap = new Capacitor<Packet>(compare);
    const client = cap.connect({});
    client.predict(0, { value: 9 });
    assert.strictEqual(cap.readConfirmed(0), false);
    const detailed = cap.readDetailed(0);
    assert.strictEqual(detailed.confirmed, false);
    assert.strictEqual(detailed.complete, true);
    assert.strictEqual(detailed.values[0]?.value, 9);
  });

  test('resolveFrame predicts and associates values with their clients', () => {
    const cap = new Capacitor<Packet>(compare);
    const client = cap.connect({ predictor: (previous) => previous ?? { value: 0 } });
    const result = cap.resolveFrame(2, { predict: true, maxPredictionLead: 4 });

    assert.strictEqual(result.complete, true);
    assert.deepStrictEqual(result.clients, [
      { client, status: 'predicted', value: { value: 0 }, active: true },
    ]);
  });

  test('readDetailed reports dirty history from a client inactive at the queried frame', () => {
    const cap = new Capacitor<Packet>(compare);
    const client = cap.connect({});
    client.predict(0, { value: 1 });
    client.commit(0, { value: 2 });
    client.deactivate(1);

    const detailed = cap.readDetailed(1);
    assert.strictEqual(detailed.rollbackFrame, 0);
    assert.deepStrictEqual(detailed.values, [null]);
  });

  test('multiple clients with offsets', () => {
    const cap = new Capacitor<Packet>(compare);
    const client1 = cap.connect({ startFrame: 6 });
    const client2 = cap.connect({ startFrame: 10 });

    for (let i = 6; i < 12; i++) {
      if (i >= 6) client1.commit(i, { value: i });
      if (i >= 10) client2.commit(i, { value: i });
    }

    for (let i = 10; i < 12; i++) {
      assert.strictEqual(cap.readConfirmed(i), true);
      assert.strictEqual(client1.cache?.value, i);
      assert.strictEqual(client2.cache?.value, i);
    }
  });

  test('partial-miss read clears caches even on the satisfied clients', () => {
    const cap = new Capacitor<Packet>(compare);
    const client1 = cap.connect({});
    const client2 = cap.connect({});

    client1.commit(0, { value: 10 });
    client2.commit(0, { value: 20 });
    assert.strictEqual(cap.readConfirmed(0), true);
    assert.strictEqual(client1.cache?.value, 10);
    assert.strictEqual(client2.cache?.value, 20);

    client1.commit(1, { value: 11 });
    assert.strictEqual(cap.readConfirmed(1), false);
    assert.strictEqual(client1.cache, null);
    assert.strictEqual(client2.cache, null);
  });

  test('consumeDirty returns the earliest correction across clients and resets', () => {
    const cap = new Capacitor<Packet>(compare);
    const c1 = cap.connect({});
    const c2 = cap.connect({});
    c1.predict(5, { value: 0 });
    c2.predict(3, { value: 0 });
    c1.commit(5, { value: 1 }); // corrected at 5
    c2.commit(3, { value: 1 }); // corrected at 3
    assert.strictEqual(cap.consumeDirty(), 3);
    assert.strictEqual(cap.consumeDirty(), null);
  });

  test('disconnect preserves an outstanding correction watermark', () => {
    const cap = new Capacitor<Packet>(compare);
    const client = cap.connect({});
    client.predict(3, { value: 0 });
    client.commit(3, { value: 1 });

    cap.disconnect(client);

    assert.strictEqual(cap.readDetailed(3).rollbackFrame, 3);
    assert.strictEqual(cap.consumeDirty(), 3);
    assert.strictEqual(cap.consumeDirty(), null);

    cap.disconnect(client);
    assert.strictEqual(cap.consumeDirty(), null);
  });

  test('size is the lockstep minimum confirmed head', () => {
    const cap = new Capacitor<Packet>(compare);
    const c1 = cap.connect({});
    const c2 = cap.connect({});
    for (let i = 0; i < 5; i++) c1.commit(i, { value: i });
    for (let i = 0; i < 3; i++) c2.commit(i, { value: i });
    assert.strictEqual(cap.size(), 3);
  });

  test('size ignores a deactivated client confirmed through its end frame', () => {
    const cap = new Capacitor<Packet>(compare);
    const ended = cap.connect({});
    const active = cap.connect({});
    for (let i = 0; i < 2; i++) ended.commit(i, { value: i });
    for (let i = 0; i < 5; i++) active.commit(i, { value: i });

    ended.deactivate(2);
    assert.strictEqual(cap.size(), 5);
  });

  test('size preserves the completed frontier when every client has ended', () => {
    const cap = new Capacitor<Packet>(compare);
    const client = cap.connect({});
    client.commit(0, { value: 0 });
    client.commit(1, { value: 1 });
    client.deactivate(2);

    assert.strictEqual(cap.size(), 2);
  });

  test('disconnected clients are not considered for size or readConfirmed', () => {
    const cap = new Capacitor<Packet>(compare);
    const c1 = cap.connect({});
    const c2 = cap.connect({});
    c1.commit(0, { value: 0 });
    cap.disconnect(c2);
    assert.strictEqual(cap.readConfirmed(0), true);
    assert.strictEqual(cap.size(), 1);
  });

  test('pendingClients returns exactly the clients blocking readConfirmed', () => {
    const cap = new Capacitor<Packet>(compare);
    const a = cap.connect({});
    const b = cap.connect({});
    const c = cap.connect({ startFrame: 5 });

    // Nothing committed yet — every client blocks frame 0; c is also
    // before its startFrame and still blocks.
    assert.deepStrictEqual(cap.pendingClients(0), [a, b, c]);
    assert.strictEqual(cap.readConfirmed(0), false);

    a.commit(0, { value: 0 });
    assert.deepStrictEqual(cap.pendingClients(0), [b, c]);

    b.commit(0, { value: 0 });
    // c is still inactive at frame 0 (startFrame 5), but it blocks
    // lockstep until its window opens.
    assert.deepStrictEqual(cap.pendingClients(0), [c]);
    assert.strictEqual(cap.readConfirmed(0), false);

    // Predicted values do not satisfy "confirmed": pendingClients still
    // flags them.
    a.predict(1, { value: 1 });
    b.commit(1, { value: 1 });
    assert.deepStrictEqual(cap.pendingClients(1), [a, c]);
  });

  test('pendingClients skips deactivated clients but includes pre-active ones', () => {
    const cap = new Capacitor<Packet>(compare);
    const a = cap.connect({});
    const b = cap.connect({});

    a.commit(0, { value: 0 });
    b.deactivate(0);

    // a satisfies frame 0; b was deactivated and is excluded.
    assert.deepStrictEqual(cap.pendingClients(0), []);
    assert.strictEqual(cap.readConfirmed(0), true);
  });
});
