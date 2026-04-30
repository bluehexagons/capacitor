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
  /** Frame already held a comparator-equal value; no rollback needed. */
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

export type Predictor<V> = (prev: V, frame: number) => V;

interface ClientProps<V> {
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
   * predicted). Without a previous value the slot is left empty.
   */
  predictor?: Predictor<V>;
}

const defaultComparator = <V>(_a: V, _b: V) => true;
const DEFAULT_HISTORY_FRAMES = 1024;

/**
 * Per-client ring buffer.
 *
 * Slots are addressed by absolute frame, mapped to ring index
 * `(frame - baseFrame) % capacity`. `baseFrame` advances forward as
 * the client outgrows the window, dropping the oldest entries. The
 * "contiguous head" `confirmedHead` only counts frames that have
 * landed without a gap from `startFrame`, mirroring the previous
 * `size` semantics.
 */
export class Client<V> {
  comparator: Comparator<V>;
  /** First absolute frame this client participates in. */
  startFrame: number;
  /** Last absolute frame this client participates in (exclusive); Infinity while active. */
  endFrame = Infinity;
  /** Ring capacity in frames. */
  capacity: number;
  /** Absolute frame stored at ring index 0 (advances with `trimBefore`). */
  baseFrame: number;
  /** Highest absolute frame contiguously committed from startFrame, exclusive. */
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
    if (historyFrames <= 0 || !Number.isFinite(historyFrames)) {
      throw new Error('historyFrames must be a positive finite integer');
    }
    const start = startFrame ?? sizeOffset ?? 0;
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
   * Mark this client as no longer participating from `frame` onward.
   * Reads / commits at or after `frame` return `kind: 'inactive'`.
   */
  deactivate(frame: number): void {
    this.endFrame = frame;
  }

  /**
   * Drop history older than `frame` by advancing `baseFrame` up to (but
   * not past) `frame`. Frames in `[baseFrame, frame)` are cleared.
   * Never trims past `writtenHead`.
   */
  trimBefore(frame: number): void {
    const target = Math.min(frame, this.writtenHead);
    while (this.baseFrame < target) {
      const slot = this.baseFrame % this.capacity;
      this.values[slot] = null;
      this.status[slot] = 'empty';
      this.baseFrame++;
    }
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
   * Write a predicted value at `frame`. Returns the same kinds as
   * `commit`, except a matching prediction overwrite reports `duplicate`
   * and `kind: 'new'` is used both for first writes and for prediction
   * upgrading an empty slot. Confirmed slots are never overwritten by a
   * prediction.
   */
  predict(frame: number, value: V): CommitResult {
    if (frame < this.startFrame) return { kind: 'stale' };
    if (frame >= this.endFrame) return { kind: 'inactive' };
    if (frame < this.baseFrame) return { kind: 'outside-window' };
    this.ensureCapacity(frame);
    const slot = frame % this.capacity;
    if (this.status[slot] === 'confirmed') {
      // Don't downgrade a confirmed value.
      const existing = this.values[slot] as V;
      if (this.comparator(existing, value)) return { kind: 'duplicate' };
      return { kind: 'corrected', rollbackFrame: frame };
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
    if (overflow > 0) this.trimBefore(this.baseFrame + overflow);
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
    if (frame < this.startFrame || frame >= this.endFrame) return null;
    if (frame < this.baseFrame || frame >= this.baseFrame + this.capacity) return null;
    const slot = frame % this.capacity;
    return this.status[slot] === 'empty' ? null : this.values[slot];
  }

  /** Reports per-client status at `frame`. */
  frameStatus(frame: number): ClientFrameStatus {
    if (frame < this.startFrame || frame >= this.endFrame) return 'empty';
    if (frame < this.baseFrame || frame >= this.baseFrame + this.capacity) return 'empty';
    return this.status[frame % this.capacity];
  }

  /**
   * Fill empty slots in `[confirmedHead, frame]` with predictions
   * generated by the configured `predictor`. Each prediction is fed the
   * value at `slot - 1` (confirmed or predicted) so a strategy can do
   * "repeat last input", "decay sticks", etc. Slots that already hold a
   * predicted or confirmed value are left untouched, so calling this
   * repeatedly is safe.
   *
   * No-op when no predictor is set, when the client is inactive at
   * `frame`, or when no anchor value exists at `confirmedHead - 1`.
   *
   * Predictions written here participate in the normal commit flow:
   * if a later confirmed commit disagrees, the dirty-frame watermark
   * advances and the rollback driver picks it up via `consumeDirty`.
   */
  ensurePredicted(frame: number): void {
    if (this.predictor === null) return;
    if (frame < this.startFrame) return;
    const target = Math.min(frame, this.endFrame - 1);
    let f = this.confirmedHead;
    if (f > target) return;
    let prev: V | null = f > this.startFrame ? this.read(f - 1) : null;
    for (; f <= target; f++) {
      const slot = f % this.capacity;
      if (this.status[slot] !== 'empty') {
        prev = this.values[slot];
        continue;
      }
      if (prev === null) return;
      const predicted = this.predictor(prev, f);
      this.predict(f, predicted);
      prev = predicted;
    }
  }
}

export interface CapacitorReadResult<V> {
  /** True if every active client has a confirmed value at this frame. */
  confirmed: boolean;
  /** True if every active client has at least a predicted value. */
  complete: boolean;
  /**
   * Earliest dirty frame across all active clients since the last
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

  constructor(public comparator: Comparator<V>) {}

  connect(props: ClientProps<V>): Client<V> {
    const client = new Client<V>({ comparator: this.comparator, ...props });
    this.clients.add(client);
    return client;
  }

  disconnect(client: Client<V>): void {
    this.clients.delete(client);
  }

  /**
   * Returns the earliest dirty frame across all clients since the last
   * call (consuming the watermark on each client) or `null` if none.
   */
  consumeDirty(): number | null {
    let earliest: number | null = null;
    for (const client of this.clients) {
      const f = client.consumeDirty();
      if (f === null) continue;
      if (earliest === null || f < earliest) earliest = f;
    }
    return earliest;
  }

  /**
   * Drop history before `frame` on every client.
   */
  trimBefore(frame: number): void {
    for (const client of this.clients) client.trimBefore(frame);
  }

  /**
   * Run each client's predictor (if configured) up through `frame`.
   * Convenience wrapper around `Client.ensurePredicted`.
   */
  ensurePredicted(frame: number): void {
    for (const client of this.clients) client.ensurePredicted(frame);
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
    const values: (V | null)[] = [];
    let confirmed = true;
    let complete = true;
    let earliestDirty: number | null = null;
    for (const client of this.clients) {
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
      if (client.dirtyFrame !== Infinity) {
        if (earliestDirty === null || client.dirtyFrame < earliestDirty) {
          earliestDirty = client.dirtyFrame;
        }
      }
    }
    return { confirmed, complete, rollbackFrame: earliestDirty, values };
  }

  clear(): void {
    this.clients.clear();
    this.commits = [];
  }

  /**
   * Lockstep size: the highest frame at which every active client has a
   * confirmed value (the minimum of each client's `confirmedHead`).
   */
  size(): number {
    if (this.clients.size === 0) return 0;
    let size = Infinity;
    for (const client of this.clients) {
      if (client.endFrame === client.startFrame) continue;
      size = Math.min(size, client.confirmedHead);
    }
    return size === Infinity ? 0 : size;
  }
}
