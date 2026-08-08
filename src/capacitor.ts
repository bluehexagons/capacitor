/**
 * Capacitor — frame-indexed input synchronization buffer.
 *
 * Stores per-client values keyed by absolute frame number in a fixed-size
 * ring buffer. Commits report whether they advanced the contiguous head,
 * matched an existing entry (idempotent retransmit), or contradicted a
 * previously-stored value — the last case is the rollback signal a host
 * uses to decide that the simulation needs to replay from `rollbackFrame`.
 *
 * The previous lockstep `read()` returned a single boolean for "all
 * clients have a value at this frame". That model is preserved as
 * `readConfirmed()`, but `frameStatus()` exposes the per-client state
 * (confirmed / predicted / missing) that a rollback driver needs.
 */

export type Comparator<V> = (a: V, b: V) => boolean;

export type CommitResult =
  /** Frame had no value previously; first commit at this slot. */
  | { kind: 'new' }
  /** No write was needed; the stored value remains authoritative and no rollback is needed. */
  | { kind: 'duplicate' }
  /** Frame held a different value; replay from `rollbackFrame`. */
  | { kind: 'corrected'; rollbackFrame: number }
  /** Frame is before this client's `startFrame`; commit ignored. */
  | { kind: 'stale' }
  /** Frame is older than `baseFrame`; window has already trimmed it. */
  | { kind: 'outside-window' }
  /** Frame is at or after `endFrame` (client deactivated). */
  | { kind: 'inactive' };

export type ClientFrameStatus =
  | 'confirmed' // a real commit has landed at this frame
  | 'predicted' // a prediction has been written but not confirmed
  | 'empty'; // nothing at this frame yet

/**
 * Generates a value to fill an empty slot during `ensurePredicted`.
 *
 * `prev` is whatever already sits at `frame - 1` (confirmed or predicted)
 * and is `null` when there is no anchor — either because `frame` equals
 * the client's `startFrame` or because the slot at `frame - 1` was
 * cleared by `trimBefore` / `invalidatePredictedFrom`. Predictors that
 * can synthesize a cold-start default (e.g. a neutral input) should
 * return a value; predictors that cannot should return `null`, leaving
 * the slot untouched.
 */
export type Predictor<V> = (prev: V | null, frame: number) => V | null;

export interface ClientProps<V> {
  comparator?: Comparator<V>;
  /**
   * First absolute frame this client participates in. Frames before
   * `startFrame` are rejected with `kind: 'stale'`. Equivalent to the
   * legacy `sizeOffset`.
   */
  startFrame?: number;
  /** Legacy alias for `startFrame`; preferred name is `startFrame`. */
  sizeOffset?: number;
  /**
   * Number of historical frames the ring buffer retains. Older frames
   * are dropped on commit / `trimBefore`. Default 1024 frames.
   */
  historyFrames?: number;
  /**
   * Optional prediction strategy. When set, `ensurePredicted(frame)`
   * fills empty slots up through `frame` by calling
   * `predictor(prevValue, frame)` for each missing slot, where
   * `prevValue` is whatever sits at `frame - 1` (confirmed or already
   * predicted). The predictor may synthesize a cold-start value when
   * `prevValue` is `null`; returning `null` leaves the slot empty.
   */
  predictor?: Predictor<V>;
}

/** Per-client options accepted by `Capacitor.connect()`. */
export type CapacitorClientProps<V> = Omit<ClientProps<V>, 'comparator'>;

const defaultComparator = <V>(a: V, b: V) => Object.is(a, b);
const DEFAULT_HISTORY_FRAMES = 1024;
const MAX_ARRAY_LENGTH = 0xffffffff;

const assertSafeFrame = (frame: number): void => {
  if (!Number.isSafeInteger(frame)) {
    throw new Error('frame must be a safe integer');
  }
};

const assertNonNegativeFrame = (frame: number): void => {
  if (!Number.isSafeInteger(frame) || frame < 0) {
    throw new Error('frame must be a non-negative safe integer');
  }
};

/**
 * Per-client ring buffer.
 *
 * Slots are addressed by absolute frame, mapped to ring index
 * `frame % capacity`. `baseFrame` advances forward as
 * the client outgrows the window, dropping the oldest entries. The
 * "contiguous head" `confirmedHead` counts frames that have landed
 * without a gap from the retained window floor. It begins at
 * `startFrame`, mirroring the previous `size` semantics, and advances
 * to `baseFrame` if an unfillable gap ages out of the bounded window.
 */
export class Client<V> {
  comparator: Comparator<V>;
  /** First absolute frame this client participates in. */
  startFrame: number;
  /** Last absolute frame this client participates in (exclusive); Infinity while active. */
  endFrame = Infinity;
  /** Ring capacity in frames. */
  capacity: number;
  /** Oldest absolute frame retained in the ring (advances with `trimBefore`). */
  baseFrame: number;
  /** Highest absolute frame contiguously committed from the retained window floor, exclusive. */
  confirmedHead: number;
  /** Last frame written (confirmed or predicted), exclusive. */
  writtenHead: number;
  /** Earliest frame whose stored value differs from a prior value (correction watermark). */
  dirtyFrame: number = Infinity;
  /** Optional pluggable prediction strategy; see `ensurePredicted`. */
  predictor: Predictor<V> | null;

  private values: (V | null)[];
  private status: ClientFrameStatus[];

  /** Cached read for `Capacitor.read()` (lockstep helper). */
  cache: V | null = null;

  /** Legacy alias — retained for callers reading the old `size` field. */
  get size(): number {
    return Math.max(0, this.confirmedHead - this.startFrame);
  }
  /** Legacy alias for the old `sizeOffset` name. */
  get sizeOffset(): number {
    return this.startFrame;
  }

  constructor({
    comparator = defaultComparator,
    startFrame,
    sizeOffset,
    historyFrames = DEFAULT_HISTORY_FRAMES,
    predictor,
  }: ClientProps<V>) {
    if (
      !Number.isSafeInteger(historyFrames) ||
      historyFrames <= 0 ||
      historyFrames > MAX_ARRAY_LENGTH
    ) {
      throw new Error(
        'historyFrames must be a positive safe integer within the maximum array length'
      );
    }
    if (startFrame !== undefined && sizeOffset !== undefined && startFrame !== sizeOffset) {
      throw new Error('startFrame and sizeOffset must match when both are provided');
    }
    const start = startFrame ?? sizeOffset ?? 0;
    assertNonNegativeFrame(start);
    this.comparator = comparator;
    this.startFrame = start;
    this.capacity = historyFrames;
    this.baseFrame = start;
    this.confirmedHead = start;
    this.writtenHead = start;
    this.predictor = predictor ?? null;
    this.values = new Array<V | null>(historyFrames).fill(null);
    this.status = new Array<ClientFrameStatus>(historyFrames).fill('empty');
  }

  /**
   * Clear all buffered input and re-anchor this client at `frame`.
   *
   * This is intentionally stronger than `trimBefore()`: it drops both
   * confirmed and predicted values, clears dirty rollback state, and makes the
   * client active again from the new frame. Consumers use this when an external
   * protocol has established a fresh frame origin (for example a synchronized
   * match start) and any values from the previous scene/frame coordinate must
   * not be read under the new clock.
   */
  resync(frame: number): void {
    assertNonNegativeFrame(frame);

    this.startFrame = frame;
    this.endFrame = Infinity;
    this.baseFrame = frame;
    this.confirmedHead = frame;
    this.writtenHead = frame;
    this.dirtyFrame = Infinity;
    this.cache = null;
    this.values.fill(null);
    this.status.fill('empty');
  }

  /**
   * Mark this client as no longer participating from `frame` onward.
   * Reads / commits at or after `frame` return `kind: 'inactive'`.
   */
  deactivate(frame: number): void {
    assertNonNegativeFrame(frame);
    this.endFrame = Math.min(this.endFrame, frame);
  }

  /**
   * Drop history older than `frame` by advancing `baseFrame` up to (but
   * not past) `frame`. Frames in `[baseFrame, frame)` are cleared.
   * Never trims past `writtenHead`.
   */
  trimBefore(frame: number): void {
    assertSafeFrame(frame);
    const target = Math.min(frame, this.writtenHead);
    this.advanceBaseFrame(target);
  }

  /**
   * Write a confirmed value at `frame`. Returns a structured result so the
   * caller can decide between "advance", "ignore duplicate", and
   * "rewind to rollbackFrame".
   */
  commit(frame: number, value: V): CommitResult {
    return this.write(frame, value, 'confirmed');
  }

  /**
   * Write a confirmed value at `frame` only if the slot is currently
   * empty. Used to back-fill a default/neutral value without clobbering
   * an existing prediction or confirmed input. Returns the same kinds
   * as `commit`, with `duplicate` reported whenever any value (predicted
   * or confirmed) is already present.
   */
  commitIfEmpty(frame: number, value: V): CommitResult {
    assertSafeFrame(frame);
    if (frame < this.startFrame) return { kind: 'stale' };
    if (frame >= this.endFrame) return { kind: 'inactive' };
    if (frame < this.baseFrame) return { kind: 'outside-window' };
    this.ensureCapacity(frame);
    const slot = frame % this.capacity;
    if (this.status[slot] !== 'empty') {
      return { kind: 'duplicate' };
    }
    this.values[slot] = value;
    this.status[slot] = 'confirmed';
    if (frame >= this.writtenHead) this.writtenHead = frame + 1;
    this.advanceConfirmedHead();
    return { kind: 'new' };
  }

  /**
   * True if `frame` holds a confirmed or predicted value within this
   * client's active window. False for empty slots, out-of-window
   * frames, or frames before / at-or-after the client's active range.
   */
  hasValue(frame: number): boolean {
    return this.frameStatus(frame) !== 'empty';
  }

  /**
   * Write a predicted value at `frame`. Returns the same kinds as
   * `commit`, except `duplicate` is returned whenever a confirmed slot
   * already exists (regardless of the proposed prediction), and `kind: 'new'`
   * is used for first writes. Confirmed slots are never overwritten by a
   * prediction because they are authoritative.
   */
  predict(frame: number, value: V): CommitResult {
    assertSafeFrame(frame);
    if (frame < this.startFrame) return { kind: 'stale' };
    if (frame >= this.endFrame) return { kind: 'inactive' };
    if (frame < this.baseFrame) return { kind: 'outside-window' };
    this.ensureCapacity(frame);
    const slot = frame % this.capacity;
    if (this.status[slot] === 'confirmed') {
      // Confirmed input is authoritative. A prediction cannot change it and
      // therefore cannot create a correction or rollback obligation.
      return { kind: 'duplicate' };
    }
    if (this.status[slot] === 'predicted') {
      const existing = this.values[slot] as V;
      if (this.comparator(existing, value)) return { kind: 'duplicate' };
      this.values[slot] = value;
      this.markDirty(frame);
      return { kind: 'corrected', rollbackFrame: frame };
    }
    this.values[slot] = value;
    this.status[slot] = 'predicted';
    if (frame >= this.writtenHead) this.writtenHead = frame + 1;
    return { kind: 'new' };
  }

  private write(frame: number, value: V, status: 'confirmed' | 'predicted'): CommitResult {
    assertSafeFrame(frame);
    if (frame < this.startFrame) return { kind: 'stale' };
    if (frame >= this.endFrame) return { kind: 'inactive' };
    if (frame < this.baseFrame) return { kind: 'outside-window' };
    this.ensureCapacity(frame);
    const slot = frame % this.capacity;
    const prevStatus = this.status[slot];
    if (prevStatus === 'confirmed') {
      const existing = this.values[slot] as V;
      if (this.comparator(existing, value)) return { kind: 'duplicate' };
      // A confirmed-vs-confirmed disagreement is the strongest correction
      // signal; preserve the new value (the wire is authoritative) and
      // mark the watermark.
      this.values[slot] = value;
      this.markDirty(frame);
      return { kind: 'corrected', rollbackFrame: frame };
    }
    let kind: CommitResult['kind'] = 'new';
    if (prevStatus === 'predicted' && status === 'confirmed') {
      const existing = this.values[slot] as V;
      if (this.comparator(existing, value)) {
        // Prediction matched the confirmed value; just upgrade status.
        kind = 'duplicate';
      } else {
        this.markDirty(frame);
        kind = 'corrected';
      }
    }
    this.values[slot] = value;
    this.status[slot] = status;
    if (frame >= this.writtenHead) this.writtenHead = frame + 1;
    if (status === 'confirmed') this.advanceConfirmedHead();
    return kind === 'corrected' ? { kind, rollbackFrame: frame } : { kind };
  }

  /**
   * Move `baseFrame` up to make room for `frame`. Frames falling out the
   * back of the window are cleared. If the requested frame is far ahead
   * of the current window we may discard the entire ring; that's a
   * caller-side bug (their input is already too far ahead of any
   * historical frame), but we keep operating instead of throwing.
   */
  private ensureCapacity(frame: number): void {
    const overflow = frame - (this.baseFrame + this.capacity - 1);
    if (overflow > 0) this.advanceBaseFrame(this.baseFrame + overflow);
  }

  /**
   * Advance the retained window in O(capacity), even when a sparse write
   * jumps many frames ahead. Any unconfirmed frames that fall behind the
   * new base can no longer be filled, so the contiguous frontier is
   * re-anchored at the first retained frame.
   */
  private advanceBaseFrame(target: number): void {
    if (target <= this.baseFrame) return;
    const distance = target - this.baseFrame;
    if (distance >= this.capacity) {
      this.values.fill(null);
      this.status.fill('empty');
    } else {
      for (let frame = this.baseFrame; frame < target; frame++) {
        const slot = frame % this.capacity;
        this.values[slot] = null;
        this.status[slot] = 'empty';
      }
    }
    this.baseFrame = target;
    if (this.confirmedHead < target) this.confirmedHead = target;
    this.advanceConfirmedHead();
  }

  /** Walks the ring forward from `confirmedHead` while slots are confirmed. */
  private advanceConfirmedHead(): void {
    while (this.confirmedHead < this.writtenHead) {
      const slot = this.confirmedHead % this.capacity;
      if (this.status[slot] !== 'confirmed') break;
      this.confirmedHead++;
    }
  }

  private markDirty(frame: number): void {
    if (frame < this.dirtyFrame) this.dirtyFrame = frame;
  }

  /**
   * Returns the earliest dirty frame since the last call and resets the
   * watermark. Use this to drive a rollback step in the consumer loop.
   */
  consumeDirty(): number | null {
    if (this.dirtyFrame === Infinity) return null;
    const f = this.dirtyFrame;
    this.dirtyFrame = Infinity;
    return f;
  }

  /**
   * Returns the value at `frame` regardless of whether it is confirmed
   * or predicted. Returns `null` for missing or out-of-window frames.
   */
  read(frame: number): V | null {
    assertSafeFrame(frame);
    if (frame < this.startFrame || frame >= this.endFrame) return null;
    if (frame < this.baseFrame || frame >= this.baseFrame + this.capacity) return null;
    const slot = frame % this.capacity;
    return this.status[slot] === 'empty' ? null : this.values[slot];
  }

  /** Reports per-client status at `frame`. */
  frameStatus(frame: number): ClientFrameStatus {
    assertSafeFrame(frame);
    if (frame < this.startFrame || frame >= this.endFrame) return 'empty';
    if (frame < this.baseFrame || frame >= this.baseFrame + this.capacity) return 'empty';
    return this.status[frame % this.capacity];
  }

  /**
   * Fill empty slots in `[confirmedHead, frame]` with predictions
   * generated by the configured `predictor`. Each prediction is fed the
   * value at `slot - 1` (confirmed or predicted, or `null` when there
   * is no anchor) so a strategy can do "repeat last input", "decay
   * sticks", "cold-start neutral", etc. Slots that already hold a
   * predicted or confirmed value are left untouched, so calling this
   * repeatedly is safe.
   *
   * No-op when no predictor is set or when the client is inactive at
   * `frame`. When `prev` is `null` (no anchor) the predictor is still
   * invoked; if it returns `null` the slot stays empty and prediction
   * halts for this call.
   *
   * Predictions written here participate in the normal commit flow:
   * if a later confirmed commit disagrees, the dirty-frame watermark
   * advances and the rollback driver picks it up via `consumeDirty`.
   */
  ensurePredicted(frame: number): void {
    assertSafeFrame(frame);
    if (this.predictor === null) return;
    if (frame < this.startFrame) return;
    const target = Math.min(frame, this.endFrame - 1);
    let f = Math.max(this.confirmedHead, this.baseFrame);
    if (f > target) return;
    let prev: V | null = f > this.startFrame ? this.read(f - 1) : null;
    for (; f <= target; f++) {
      // Move the window before checking the modulo slot. Otherwise a frame
      // beyond the current window can alias an occupied old slot and be
      // mistaken for an existing prediction.
      this.ensureCapacity(f);
      const slot = f % this.capacity;
      if (this.status[slot] !== 'empty') {
        prev = this.values[slot];
        continue;
      }
      const predicted = this.predictor(prev, f);
      if (predicted === null) return;
      this.predict(f, predicted);
      prev = predicted;
    }
  }

  /**
   * Drop predicted values at `[frame, writtenHead)`, leaving confirmed
   * values intact. Used by rollback drivers after a `corrected` commit:
   * the just-confirmed value at the dirty frame invalidates every
   * downstream prediction that was built on top of the now-stale
   * anchor, so clearing them forces `ensurePredicted` to recompute
   * from the corrected value on the next replay pass.
   *
   * `writtenHead` is reset to the last frame that still holds a value
   * after clearing so subsequent `ensurePredicted` writes extend it
   * naturally. Slots marked `confirmed` are left untouched. Returns
   * the number of slots cleared, primarily for tests / diagnostics.
   */
  invalidatePredictedFrom(frame: number): number {
    assertSafeFrame(frame);
    if (frame >= this.writtenHead) return 0;
    const start = Math.max(frame, this.baseFrame);
    let cleared = 0;
    let lastWritten = start - 1;
    for (let f = start; f < this.writtenHead; f++) {
      const slot = f % this.capacity;
      if (this.status[slot] === 'confirmed') {
        lastWritten = f;
        continue;
      }
      if (this.status[slot] === 'predicted') {
        this.status[slot] = 'empty';
        this.values[slot] = null;
        cleared++;
      }
    }
    // writtenHead is exclusive of the last written frame; trim it back
    // so future writes/predictions extend cleanly. A confirmed slot
    // before `frame` is still in range and untouched.
    if (lastWritten + 1 < this.writtenHead) {
      // Walk backwards from writtenHead to find the new boundary,
      // which is the highest non-empty slot.
      let newHead = this.writtenHead;
      while (newHead > start) {
        const slot = (newHead - 1) % this.capacity;
        if (this.status[slot] !== 'empty') break;
        newHead--;
      }
      this.writtenHead = newHead;
    }
    return cleared;
  }
}

export interface CapacitorReadResult<V> {
  /** True if every active client has a confirmed value at this frame. */
  confirmed: boolean;
  /** True if every active client has at least a predicted value. */
  complete: boolean;
  /**
   * Earliest dirty frame across all clients since the last
   * `consumeDirty()`, or `null` if nothing is pending.
   */
  rollbackFrame: number | null;
  /** Per-client values in client-iteration order. `null` for missing. */
  values: (V | null)[];
}

/**
 * Capacitor manages a set of clients sharing a comparator. The
 * top-level `read()` is a lockstep helper preserved for callers that
 * only need "did everyone produce a frame yet?"; rollback drivers
 * should prefer `readDetailed()` and `consumeDirty()`.
 */
export class Capacitor<C, V> {
  /** Reserved for future game-state checkpoint storage. Unused today. */
  commits: C[] = [];
  clients = new Set<Client<V>>();
  private detachedDirtyFrame = Infinity;

  constructor(public comparator: Comparator<V>) {}

  connect(props: CapacitorClientProps<V> = {}): Client<V> {
    const client = new Client<V>({ ...props, comparator: this.comparator });
    this.clients.add(client);
    return client;
  }

  disconnect(client: Client<V>): void {
    if (!this.clients.delete(client)) {
      return;
    }
    const dirtyFrame = client.consumeDirty();
    if (dirtyFrame !== null && dirtyFrame < this.detachedDirtyFrame) {
      this.detachedDirtyFrame = dirtyFrame;
    }
  }

  /**
   * Returns the earliest dirty frame across all clients since the last
   * call (consuming the watermark on each client) or `null` if none.
   */
  consumeDirty(): number | null {
    let earliest = this.detachedDirtyFrame;
    this.detachedDirtyFrame = Infinity;
    for (const client of this.clients) {
      const f = client.consumeDirty();
      if (f === null) continue;
      if (f < earliest) earliest = f;
    }
    return earliest === Infinity ? null : earliest;
  }

  /**
   * Drop history before `frame` on every client.
   */
  trimBefore(frame: number): void {
    assertSafeFrame(frame);
    for (const client of this.clients) client.trimBefore(frame);
  }

  /**
   * Run each client's predictor (if configured) up through `frame`.
   * Convenience wrapper around `Client.ensurePredicted`.
   */
  ensurePredicted(frame: number): void {
    assertSafeFrame(frame);
    for (const client of this.clients) client.ensurePredicted(frame);
  }

  /**
   * Drop predicted values at `[frame, writtenHead)` on every client.
   * Convenience wrapper around `Client.invalidatePredictedFrom` for
   * rollback drivers that just consumed a dirty marker and want to
   * recompute predictions from the corrected anchor.
   */
  invalidatePredictedFrom(frame: number): void {
    assertSafeFrame(frame);
    for (const client of this.clients) client.invalidatePredictedFrom(frame);
  }

  /**
   * Clear every connected client's buffered values and re-anchor them at
   * `frame`. Existing Client objects are preserved so external maps/references
   * remain valid.
   */
  resync(frame: number): void {
    assertNonNegativeFrame(frame);
    this.detachedDirtyFrame = Infinity;
    for (const client of this.clients) client.resync(frame);
  }

  /**
   * Lockstep read: returns true iff every client active at `frame` has a
   * confirmed value. Mirrors the previous boolean `read()` API and
   * updates `client.cache` for callers that scrape it.
   *
   * Not-yet-active clients (frame < startFrame) block the lockstep —
   * the consumer should advance frames until late-joining controllers
   * are caught up. Deactivated clients (frame >= endFrame) are skipped.
   */
  readConfirmed(frame: number): boolean {
    assertSafeFrame(frame);
    let ok = true;
    for (const client of this.clients) {
      if (frame >= client.endFrame) {
        client.cache = null;
        continue;
      }
      if (frame < client.startFrame) {
        client.cache = null;
        ok = false;
        continue;
      }
      const status = client.frameStatus(frame);
      const v = client.read(frame);
      client.cache = status === 'confirmed' ? v : null;
      if (status !== 'confirmed') ok = false;
    }
    if (!ok) {
      // Match the previous semantics: a partial-miss read clears all
      // caches so callers don't see stale data from the OK clients.
      for (const client of this.clients) client.cache = null;
    }
    return ok;
  }

  /** Backwards-compatible alias kept for legacy callers. */
  read(frame: number): boolean {
    return this.readConfirmed(frame);
  }

  /**
   * Rollback-aware read. Returns per-client status + values + the
   * earliest dirty frame across all clients (without consuming it).
   * Like `readConfirmed`, a not-yet-active client (frame < startFrame)
   * blocks `complete` / `confirmed`; deactivated clients are skipped.
   */
  readDetailed(frame: number): CapacitorReadResult<V> {
    assertSafeFrame(frame);
    const values: (V | null)[] = [];
    let confirmed = true;
    let complete = true;
    let earliestDirty = this.detachedDirtyFrame;
    for (const client of this.clients) {
      if (client.dirtyFrame !== Infinity) {
        if (client.dirtyFrame < earliestDirty) {
          earliestDirty = client.dirtyFrame;
        }
      }
      if (frame >= client.endFrame) {
        values.push(null);
        continue;
      }
      if (frame < client.startFrame) {
        values.push(null);
        confirmed = false;
        complete = false;
        continue;
      }
      const status = client.frameStatus(frame);
      values.push(client.read(frame));
      if (status !== 'confirmed') confirmed = false;
      if (status === 'empty') complete = false;
    }
    return {
      confirmed,
      complete,
      rollbackFrame: earliestDirty === Infinity ? null : earliestDirty,
      values,
    };
  }

  /**
   * Returns the clients that do not have a confirmed value at `frame`
   * within their active window. Useful for diagnosing why
   * `readConfirmed`/`read` returned false: the resulting array is
   * exactly the set of clients blocking the lockstep. Clients that
   * are inactive at `frame` (`frame >= endFrame`) are excluded; clients
   * not yet active (`frame < startFrame`) are included since they still
   * block.
   *
   * Iterates clients in insertion order so callers can correlate the
   * result with their own controller / participant arrays.
   */
  pendingClients(frame: number): Client<V>[] {
    assertSafeFrame(frame);
    const pending: Client<V>[] = [];
    for (const client of this.clients) {
      if (frame >= client.endFrame) continue;
      if (frame < client.startFrame) {
        pending.push(client);
        continue;
      }
      if (client.frameStatus(frame) !== 'confirmed') {
        pending.push(client);
      }
    }
    return pending;
  }

  clear(): void {
    this.clients.clear();
    this.commits = [];
    this.detachedDirtyFrame = Infinity;
  }

  /**
   * Lockstep size: the highest frame at which every active client has a
   * confirmed value (the minimum of each client's `confirmedHead`).
   */
  size(): number {
    if (this.clients.size === 0) return 0;
    let size = Infinity;
    let completedEnd = 0;
    for (const client of this.clients) {
      // Once a deactivated client is confirmed through its exclusive end,
      // it imposes no constraints on later frames.
      if (client.confirmedHead >= client.endFrame) {
        if (client.endFrame > client.startFrame) {
          completedEnd = Math.max(completedEnd, client.endFrame);
        }
        continue;
      }
      size = Math.min(size, client.confirmedHead);
    }
    return size === Infinity ? completedEnd : size;
  }
}
