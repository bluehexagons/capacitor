import { Capacitor } from '../src/capacitor.js';

interface State {
  text: string;
}

interface Packet {
  value: number;
}

const compare = (a: Packet, b: Packet) => a.value === b.value;

describe('Client', () => {
  test('first commit reports new, idempotent retransmit reports duplicate', () => {
    const cap = new Capacitor<State, Packet>(compare);
    const client = cap.connect({});
    expect(client.read(0)).toBe(null);
    expect(client.size).toBe(0);

    expect(client.commit(0, { value: 0 }).kind).toBe('new');
    expect(client.read(0)?.value).toBe(0);

    // Retransmitted-but-changed packet is a correction, not a duplicate.
    const corrected = client.commit(0, { value: 1 });
    expect(corrected.kind).toBe('corrected');
    if (corrected.kind === 'corrected') expect(corrected.rollbackFrame).toBe(0);
    expect(client.read(0)?.value).toBe(1);

    // Re-sending the now-current value is a duplicate.
    expect(client.commit(0, { value: 1 }).kind).toBe('duplicate');
    expect(client.read(0)?.value).toBe(1);
  });

  test('non-contiguous commits do not advance confirmedHead', () => {
    const cap = new Capacitor<State, Packet>(compare);
    const client = cap.connect({});
    expect(client.commit(0, { value: 0 }).kind).toBe('new');
    expect(client.commit(1, { value: 0 }).kind).toBe('new');
    expect(client.size).toBe(2);

    // Skip frame 2; head should not move past 2.
    expect(client.commit(4, { value: 4 }).kind).toBe('new');
    expect(client.read(2)).toBe(null);
    expect(client.size).toBe(2);

    // Filling the gap brings head all the way up.
    expect(client.commit(3, { value: 3 }).kind).toBe('new');
    expect(client.commit(2, { value: 2 }).kind).toBe('new');
    expect(client.size).toBe(5);
    expect(client.read(2)?.value).toBe(2);
    expect(client.read(4)?.value).toBe(4);
  });

  test('startFrame rejects earlier commits as stale', () => {
    const cap = new Capacitor<State, Packet>(compare);
    const client = cap.connect({ startFrame: 5 });
    expect(client.startFrame).toBe(5);
    expect(client.sizeOffset).toBe(5);

    expect(client.commit(4, { value: 4 }).kind).toBe('stale');
    expect(client.size).toBe(0);
    expect(client.read(4)).toBe(null);

    expect(client.commit(5, { value: 5 }).kind).toBe('new');
    expect(client.read(5)?.value).toBe(5);

    expect(client.commit(6, { value: 6 }).kind).toBe('new');
    expect(client.read(6)?.value).toBe(6);
    expect(client.size).toBe(2);
  });

  test('predict then matching confirm reports duplicate, mismatching confirm reports corrected', () => {
    const cap = new Capacitor<State, Packet>(compare);
    const client = cap.connect({});
    expect(client.predict(0, { value: 9 }).kind).toBe('new');
    expect(client.frameStatus(0)).toBe('predicted');

    // Match: prediction confirmed without rollback.
    expect(client.commit(0, { value: 9 }).kind).toBe('duplicate');
    expect(client.frameStatus(0)).toBe('confirmed');
    expect(client.consumeDirty()).toBe(null);

    // Mismatch: prediction was wrong; rollback frame surfaces.
    expect(client.predict(1, { value: 1 }).kind).toBe('new');
    const result = client.commit(1, { value: 2 });
    expect(result.kind).toBe('corrected');
    if (result.kind === 'corrected') expect(result.rollbackFrame).toBe(1);
    expect(client.consumeDirty()).toBe(1);
    expect(client.consumeDirty()).toBe(null);
  });

  test('predict cannot downgrade confirmed; matching predict is duplicate', () => {
    const cap = new Capacitor<State, Packet>(compare);
    const client = cap.connect({});
    expect(client.commit(0, { value: 5 }).kind).toBe('new');
    expect(client.predict(0, { value: 5 }).kind).toBe('duplicate');
    expect(client.predict(0, { value: 9 }).kind).toBe('corrected');
    expect(client.frameStatus(0)).toBe('confirmed');
    expect(client.read(0)?.value).toBe(5);
  });

  test('history bound trims oldest entries on overflow', () => {
    const cap = new Capacitor<State, Packet>(compare);
    const client = cap.connect({ historyFrames: 4 });
    for (let i = 0; i < 6; i++) {
      expect(client.commit(i, { value: i }).kind).toBe('new');
    }
    expect(client.read(0)).toBe(null); // trimmed
    expect(client.read(1)).toBe(null); // trimmed
    expect(client.read(2)?.value).toBe(2);
    expect(client.read(5)?.value).toBe(5);

    // A re-commit landing in the trimmed region is rejected.
    expect(client.commit(0, { value: 0 }).kind).toBe('outside-window');
  });

  test('trimBefore advances baseFrame and clears slots', () => {
    const cap = new Capacitor<State, Packet>(compare);
    const client = cap.connect({});
    for (let i = 0; i < 5; i++) client.commit(i, { value: i });
    client.trimBefore(3);
    expect(client.read(2)).toBe(null);
    expect(client.read(3)?.value).toBe(3);
  });

  test('deactivate stops accepting commits at endFrame', () => {
    const cap = new Capacitor<State, Packet>(compare);
    const client = cap.connect({});
    client.commit(0, { value: 0 });
    client.deactivate(2);
    expect(client.commit(2, { value: 2 }).kind).toBe('inactive');
    expect(client.commit(1, { value: 1 }).kind).toBe('new');
  });

  test('ensurePredicted fills empty slots with the predictor strategy', () => {
    const cap = new Capacitor<State, Packet>(compare);
    const client = cap.connect({
      predictor: (prev) => ({ value: prev.value }), // repeat last input
    });
    client.commit(0, { value: 7 });
    client.ensurePredicted(4);
    expect(client.frameStatus(1)).toBe('predicted');
    expect(client.frameStatus(4)).toBe('predicted');
    expect(client.read(4)?.value).toBe(7);
    expect(client.confirmedHead).toBe(1); // predictions don't advance confirmedHead
  });

  test('ensurePredicted is a no-op without an anchor or a predictor', () => {
    const cap = new Capacitor<State, Packet>(compare);
    const noPredictor = cap.connect({});
    noPredictor.commit(0, { value: 1 });
    noPredictor.ensurePredicted(5);
    expect(noPredictor.frameStatus(1)).toBe('empty');

    const noAnchor = cap.connect({ predictor: (prev) => prev });
    noAnchor.ensurePredicted(5);
    expect(noAnchor.frameStatus(0)).toBe('empty');
  });

  test('matching commit upgrades a prediction without rollback', () => {
    const cap = new Capacitor<State, Packet>(compare);
    const client = cap.connect({ predictor: (prev) => prev });
    client.commit(0, { value: 3 });
    client.ensurePredicted(2);
    expect(client.frameStatus(1)).toBe('predicted');

    expect(client.commit(1, { value: 3 }).kind).toBe('duplicate');
    expect(client.frameStatus(1)).toBe('confirmed');
    expect(client.confirmedHead).toBe(2);
    expect(client.consumeDirty()).toBe(null);

    // Frame 2 prediction disagrees with the wire input → correction.
    const result = client.commit(2, { value: 99 });
    expect(result.kind).toBe('corrected');
    expect(client.consumeDirty()).toBe(2);
  });

  test('ensurePredicted leaves already-written slots alone', () => {
    const cap = new Capacitor<State, Packet>(compare);
    const client = cap.connect({ predictor: (prev) => ({ value: prev.value + 1 }) });
    client.commit(0, { value: 0 });
    // Land a confirmed value mid-stream as well.
    client.commit(3, { value: 42 });
    client.ensurePredicted(5);
    expect(client.read(3)?.value).toBe(42); // confirmed value preserved
    expect(client.read(1)?.value).toBe(1);
    expect(client.read(2)?.value).toBe(2);
    // After the confirmed gap, predictions resume from the confirmed value.
    expect(client.read(4)?.value).toBe(43);
    expect(client.read(5)?.value).toBe(44);
  });

  test('invalidatePredictedFrom drops predictions and lets ensurePredicted recompute', () => {
    const cap = new Capacitor<State, Packet>(compare);
    const client = cap.connect({ predictor: (prev) => ({ value: prev.value + 1 }) });
    client.commit(0, { value: 0 });
    client.ensurePredicted(5);
    // Predictions: 1..5 derived from anchor 0.
    expect(client.read(5)?.value).toBe(5);
    // A late-arriving confirmed correction at frame 2 invalidates 3..5.
    const result = client.commit(2, { value: 100 });
    expect(result.kind).toBe('corrected');
    const cleared = client.invalidatePredictedFrom(3);
    expect(cleared).toBe(3);
    expect(client.frameStatus(3)).toBe('empty');
    expect(client.frameStatus(5)).toBe('empty');
    // Confirmed slots are preserved.
    expect(client.read(2)?.value).toBe(100);
    // Re-running ensurePredicted now anchors on the corrected value.
    client.ensurePredicted(5);
    expect(client.read(3)?.value).toBe(101);
    expect(client.read(5)?.value).toBe(103);
  });

  test('invalidatePredictedFrom preserves confirmed slots after the boundary', () => {
    const cap = new Capacitor<State, Packet>(compare);
    const client = cap.connect({ predictor: (prev) => ({ value: prev.value + 1 }) });
    client.commit(0, { value: 0 });
    client.predict(1, { value: 11 });
    client.commit(2, { value: 22 });
    client.predict(3, { value: 33 });
    client.invalidatePredictedFrom(1);
    expect(client.frameStatus(1)).toBe('empty');
    expect(client.frameStatus(2)).toBe('confirmed');
    expect(client.read(2)?.value).toBe(22);
    expect(client.frameStatus(3)).toBe('empty');
  });

  test('Capacitor.invalidatePredictedFrom delegates to every client', () => {
    const cap = new Capacitor<State, Packet>(compare);
    const a = cap.connect({ predictor: (prev) => ({ value: prev.value + 1 }) });
    const b = cap.connect({ predictor: (prev) => ({ value: prev.value + 10 }) });
    a.commit(0, { value: 0 });
    b.commit(0, { value: 0 });
    cap.ensurePredicted(3);
    cap.invalidatePredictedFrom(1);
    expect(a.frameStatus(1)).toBe('empty');
    expect(b.frameStatus(1)).toBe('empty');
  });
});

describe('Capacitor lockstep helpers', () => {
  test('readConfirmed only returns true once every client has a confirmed value', () => {
    const cap = new Capacitor<State, Packet>(compare);
    const client = cap.connect({});

    expect(cap.readConfirmed(0)).toBe(false);
    expect(client.cache).toBe(null);

    client.commit(1, { value: 0 });
    expect(cap.readConfirmed(0)).toBe(false);

    client.commit(0, { value: 1 });
    expect(cap.readConfirmed(0)).toBe(true);
    expect(client.cache?.value).toBe(1);

    expect(cap.readConfirmed(1)).toBe(true);
    expect(client.cache?.value).toBe(0);

    expect(cap.readConfirmed(2)).toBe(false);
  });

  test('predicted values do not satisfy readConfirmed but do satisfy readDetailed.complete', () => {
    const cap = new Capacitor<State, Packet>(compare);
    const client = cap.connect({});
    client.predict(0, { value: 9 });
    expect(cap.readConfirmed(0)).toBe(false);
    const detailed = cap.readDetailed(0);
    expect(detailed.confirmed).toBe(false);
    expect(detailed.complete).toBe(true);
    expect(detailed.values[0]?.value).toBe(9);
  });

  test('multiple clients with offsets', () => {
    const cap = new Capacitor<State, Packet>(compare);
    const client1 = cap.connect({ startFrame: 6 });
    const client2 = cap.connect({ startFrame: 10 });

    for (let i = 6; i < 12; i++) {
      if (i >= 6) client1.commit(i, { value: i });
      if (i >= 10) client2.commit(i, { value: i });
    }

    for (let i = 10; i < 12; i++) {
      expect(cap.readConfirmed(i)).toBe(true);
      expect(client1.cache?.value).toBe(i);
      expect(client2.cache?.value).toBe(i);
    }
  });

  test('partial-miss read clears caches even on the satisfied clients', () => {
    const cap = new Capacitor<State, Packet>(compare);
    const client1 = cap.connect({});
    const client2 = cap.connect({});

    client1.commit(0, { value: 10 });
    client2.commit(0, { value: 20 });
    expect(cap.readConfirmed(0)).toBe(true);
    expect(client1.cache?.value).toBe(10);
    expect(client2.cache?.value).toBe(20);

    client1.commit(1, { value: 11 });
    expect(cap.readConfirmed(1)).toBe(false);
    expect(client1.cache).toBe(null);
    expect(client2.cache).toBe(null);
  });

  test('consumeDirty returns the earliest correction across clients and resets', () => {
    const cap = new Capacitor<State, Packet>(compare);
    const c1 = cap.connect({});
    const c2 = cap.connect({});
    c1.predict(5, { value: 0 });
    c2.predict(3, { value: 0 });
    c1.commit(5, { value: 1 }); // corrected at 5
    c2.commit(3, { value: 1 }); // corrected at 3
    expect(cap.consumeDirty()).toBe(3);
    expect(cap.consumeDirty()).toBe(null);
  });

  test('size is the lockstep minimum confirmed head', () => {
    const cap = new Capacitor<State, Packet>(compare);
    const c1 = cap.connect({});
    const c2 = cap.connect({});
    for (let i = 0; i < 5; i++) c1.commit(i, { value: i });
    for (let i = 0; i < 3; i++) c2.commit(i, { value: i });
    expect(cap.size()).toBe(3);
  });

  test('disconnected clients are not considered for size or readConfirmed', () => {
    const cap = new Capacitor<State, Packet>(compare);
    const c1 = cap.connect({});
    const c2 = cap.connect({});
    c1.commit(0, { value: 0 });
    cap.disconnect(c2);
    expect(cap.readConfirmed(0)).toBe(true);
    expect(cap.size()).toBe(1);
  });
});
