export class RollbackRing {
    window;
    slots;
    occupied;
    saveSnapshot;
    loadSnapshot;
    unsafeSinceFrame = -1;
    unsafeReasons = [];
    constructor({ window = 32, createSnapshot, saveSnapshot, loadSnapshot, }) {
        if (!Number.isSafeInteger(window) || window < 2) {
            throw new Error('RollbackRing window must be a safe integer of at least 2');
        }
        this.window = window;
        this.slots = Array.from({ length: window }, createSnapshot);
        this.occupied = new Array(window).fill(-1);
        this.saveSnapshot = saveSnapshot;
        this.loadSnapshot = loadSnapshot;
    }
    slotIndex(frame) {
        return ((frame % this.window) + this.window) % this.window;
    }
    save(frame, ...args) {
        this.assertFrame(frame);
        const slot = this.slotIndex(frame);
        this.saveSnapshot(this.slots[slot], frame, ...args);
        this.occupied[slot] = frame;
    }
    refusalReason(frame) {
        this.assertFrame(frame);
        if (frame <= this.unsafeSinceFrame)
            return 'unsafe-boundary';
        if (this.occupied[this.slotIndex(frame)] === frame)
            return null;
        return this.occupied.some((occupied) => occupied !== -1 && occupied >= frame + this.window)
            ? 'out-of-window'
            : 'missing-snapshot';
    }
    load(frame) {
        if (this.refusalReason(frame) !== null)
            return -1;
        this.loadSnapshot(this.slots[this.slotIndex(frame)], frame);
        return frame;
    }
    peek(frame) {
        this.assertFrame(frame);
        const slot = this.slotIndex(frame);
        return this.occupied[slot] === frame ? this.slots[slot] : null;
    }
    markUnsafe(frame, reason) {
        this.assertFrame(frame);
        if (frame > this.unsafeSinceFrame) {
            this.unsafeSinceFrame = frame;
            this.unsafeReasons = [reason];
        }
        else if (frame === this.unsafeSinceFrame && !this.unsafeReasons.includes(reason)) {
            this.unsafeReasons.push(reason);
        }
    }
    clear() {
        this.occupied.fill(-1);
        this.unsafeSinceFrame = -1;
        this.unsafeReasons = [];
    }
    assertFrame(frame) {
        if (!Number.isSafeInteger(frame) || frame < 0) {
            throw new Error('frame must be a non-negative safe integer');
        }
    }
}
export class RollbackCorrectionQueue {
    deferredFrame = null;
    get deferred() {
        return this.deferredFrame;
    }
    consumeEarliest(consumeDirty) {
        let earliest = consumeDirty();
        while (true) {
            const next = consumeDirty();
            if (next === null)
                return earliest;
            if (earliest === null || next < earliest)
                earliest = next;
        }
    }
    defer(frame) {
        if (!Number.isSafeInteger(frame) || frame < 0) {
            throw new Error('frame must be a non-negative safe integer');
        }
        this.deferredFrame = this.deferredFrame === null ? frame : Math.min(this.deferredFrame, frame);
    }
    clear(consumeDirty) {
        this.deferredFrame = null;
        while (consumeDirty() !== null) {
        }
    }
}
//# sourceMappingURL=rollback.js.map