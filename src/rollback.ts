export type RollbackRefusalReason = 'out-of-window' | 'unsafe-boundary' | 'missing-snapshot';

export interface RollbackRingOptions<Snapshot, SaveArgs extends unknown[]> {
  window?: number;
  createSnapshot: () => Snapshot;
  saveSnapshot: (snapshot: Snapshot, frame: number, ...args: SaveArgs) => void;
  loadSnapshot: (snapshot: Snapshot, frame: number) => void;
}

/**
 * Bounded, frame-indexed snapshot storage for rollback simulations.
 * Snapshot representation and capture/restore behavior remain consumer-owned.
 */
export class RollbackRing<Snapshot, UnsafeReason = string, SaveArgs extends unknown[] = []> {
  readonly window: number;
  private readonly slots: Snapshot[];
  private readonly occupied: number[];
  private readonly saveSnapshot: RollbackRingOptions<Snapshot, SaveArgs>['saveSnapshot'];
  private readonly loadSnapshot: RollbackRingOptions<Snapshot, SaveArgs>['loadSnapshot'];
  unsafeSinceFrame = -1;
  unsafeReasons: UnsafeReason[] = [];

  constructor({
    window = 32,
    createSnapshot,
    saveSnapshot,
    loadSnapshot,
  }: RollbackRingOptions<Snapshot, SaveArgs>) {
    if (!Number.isSafeInteger(window) || window < 2) {
      throw new Error('RollbackRing window must be a safe integer of at least 2');
    }
    this.window = window;
    this.slots = Array.from({ length: window }, createSnapshot);
    this.occupied = new Array<number>(window).fill(-1);
    this.saveSnapshot = saveSnapshot;
    this.loadSnapshot = loadSnapshot;
  }

  private slotIndex(frame: number): number {
    return ((frame % this.window) + this.window) % this.window;
  }

  save(frame: number, ...args: SaveArgs): void {
    this.assertFrame(frame);
    const slot = this.slotIndex(frame);
    this.saveSnapshot(this.slots[slot], frame, ...args);
    this.occupied[slot] = frame;
  }

  refusalReason(frame: number): RollbackRefusalReason | null {
    this.assertFrame(frame);
    if (frame <= this.unsafeSinceFrame) return 'unsafe-boundary';
    if (this.occupied[this.slotIndex(frame)] === frame) return null;
    return this.occupied.some((occupied) => occupied !== -1 && occupied >= frame + this.window)
      ? 'out-of-window'
      : 'missing-snapshot';
  }

  load(frame: number): number {
    if (this.refusalReason(frame) !== null) return -1;
    this.loadSnapshot(this.slots[this.slotIndex(frame)], frame);
    return frame;
  }

  peek(frame: number): Snapshot | null {
    this.assertFrame(frame);
    const slot = this.slotIndex(frame);
    return this.occupied[slot] === frame ? this.slots[slot] : null;
  }

  markUnsafe(frame: number, reason: UnsafeReason): void {
    this.assertFrame(frame);
    if (frame > this.unsafeSinceFrame) {
      this.unsafeSinceFrame = frame;
      this.unsafeReasons = [reason];
    } else if (frame === this.unsafeSinceFrame && !this.unsafeReasons.includes(reason)) {
      this.unsafeReasons.push(reason);
    }
  }

  clear(): void {
    this.occupied.fill(-1);
    this.unsafeSinceFrame = -1;
    this.unsafeReasons = [];
  }

  private assertFrame(frame: number): void {
    if (!Number.isSafeInteger(frame) || frame < 0) {
      throw new Error('frame must be a non-negative safe integer');
    }
  }
}

/** Retains the earliest unresolved correction until the consumer handles it. */
export class RollbackCorrectionQueue {
  private deferredFrame: number | null = null;

  get deferred(): number | null {
    return this.deferredFrame;
  }

  consumeEarliest(consumeDirty: () => number | null): number | null {
    let earliest = consumeDirty();
    while (true) {
      const next = consumeDirty();
      if (next === null) return earliest;
      if (earliest === null || next < earliest) earliest = next;
    }
  }

  defer(frame: number): void {
    if (!Number.isSafeInteger(frame) || frame < 0) {
      throw new Error('frame must be a non-negative safe integer');
    }
    this.deferredFrame = this.deferredFrame === null ? frame : Math.min(this.deferredFrame, frame);
  }

  clear(consumeDirty: () => number | null): void {
    this.deferredFrame = null;
    while (consumeDirty() !== null) {
      // Drain correction watermarks owned by the discarded timeline.
    }
  }
}
