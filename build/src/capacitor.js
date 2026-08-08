const defaultComparator = (a, b) => Object.is(a, b);
const DEFAULT_HISTORY_FRAMES = 1024;
const MAX_ARRAY_LENGTH = 0xffffffff;
const assertSafeFrame = (frame) => {
    if (!Number.isSafeInteger(frame)) {
        throw new Error('frame must be a safe integer');
    }
};
const assertNonNegativeFrame = (frame) => {
    if (!Number.isSafeInteger(frame) || frame < 0) {
        throw new Error('frame must be a non-negative safe integer');
    }
};
export class Client {
    comparator;
    startFrame;
    endFrame = Infinity;
    capacity;
    baseFrame;
    confirmedHead;
    writtenHead;
    dirtyFrame = Infinity;
    predictor;
    values;
    status;
    cache = null;
    get size() {
        return Math.max(0, this.confirmedHead - this.startFrame);
    }
    get sizeOffset() {
        return this.startFrame;
    }
    constructor({ comparator = defaultComparator, startFrame, sizeOffset, historyFrames = DEFAULT_HISTORY_FRAMES, predictor, }) {
        if (!Number.isSafeInteger(historyFrames) ||
            historyFrames <= 0 ||
            historyFrames > MAX_ARRAY_LENGTH) {
            throw new Error('historyFrames must be a positive safe integer within the maximum array length');
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
        this.values = new Array(historyFrames).fill(null);
        this.status = new Array(historyFrames).fill('empty');
    }
    resync(frame) {
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
    deactivate(frame) {
        assertNonNegativeFrame(frame);
        this.endFrame = Math.min(this.endFrame, frame);
    }
    trimBefore(frame) {
        assertSafeFrame(frame);
        const target = Math.min(frame, this.writtenHead);
        this.advanceBaseFrame(target);
    }
    commit(frame, value) {
        return this.write(frame, value, 'confirmed');
    }
    commitIfEmpty(frame, value) {
        assertSafeFrame(frame);
        if (frame < this.startFrame)
            return { kind: 'stale' };
        if (frame >= this.endFrame)
            return { kind: 'inactive' };
        if (frame < this.baseFrame)
            return { kind: 'outside-window' };
        this.ensureCapacity(frame);
        const slot = frame % this.capacity;
        if (this.status[slot] !== 'empty') {
            return { kind: 'duplicate' };
        }
        this.values[slot] = value;
        this.status[slot] = 'confirmed';
        if (frame >= this.writtenHead)
            this.writtenHead = frame + 1;
        this.advanceConfirmedHead();
        return { kind: 'new' };
    }
    hasValue(frame) {
        return this.frameStatus(frame) !== 'empty';
    }
    predict(frame, value) {
        assertSafeFrame(frame);
        if (frame < this.startFrame)
            return { kind: 'stale' };
        if (frame >= this.endFrame)
            return { kind: 'inactive' };
        if (frame < this.baseFrame)
            return { kind: 'outside-window' };
        this.ensureCapacity(frame);
        const slot = frame % this.capacity;
        if (this.status[slot] === 'confirmed') {
            return { kind: 'duplicate' };
        }
        if (this.status[slot] === 'predicted') {
            const existing = this.values[slot];
            if (this.comparator(existing, value))
                return { kind: 'duplicate' };
            this.values[slot] = value;
            this.markDirty(frame);
            return { kind: 'corrected', rollbackFrame: frame };
        }
        this.values[slot] = value;
        this.status[slot] = 'predicted';
        if (frame >= this.writtenHead)
            this.writtenHead = frame + 1;
        return { kind: 'new' };
    }
    write(frame, value, status) {
        assertSafeFrame(frame);
        if (frame < this.startFrame)
            return { kind: 'stale' };
        if (frame >= this.endFrame)
            return { kind: 'inactive' };
        if (frame < this.baseFrame)
            return { kind: 'outside-window' };
        this.ensureCapacity(frame);
        const slot = frame % this.capacity;
        const prevStatus = this.status[slot];
        if (prevStatus === 'confirmed') {
            const existing = this.values[slot];
            if (this.comparator(existing, value))
                return { kind: 'duplicate' };
            this.values[slot] = value;
            this.markDirty(frame);
            return { kind: 'corrected', rollbackFrame: frame };
        }
        let kind = 'new';
        if (prevStatus === 'predicted' && status === 'confirmed') {
            const existing = this.values[slot];
            if (this.comparator(existing, value)) {
                kind = 'duplicate';
            }
            else {
                this.markDirty(frame);
                kind = 'corrected';
            }
        }
        this.values[slot] = value;
        this.status[slot] = status;
        if (frame >= this.writtenHead)
            this.writtenHead = frame + 1;
        if (status === 'confirmed')
            this.advanceConfirmedHead();
        return kind === 'corrected' ? { kind, rollbackFrame: frame } : { kind };
    }
    ensureCapacity(frame) {
        const overflow = frame - (this.baseFrame + this.capacity - 1);
        if (overflow > 0)
            this.advanceBaseFrame(this.baseFrame + overflow);
    }
    advanceBaseFrame(target) {
        if (target <= this.baseFrame)
            return;
        const distance = target - this.baseFrame;
        if (distance >= this.capacity) {
            this.values.fill(null);
            this.status.fill('empty');
        }
        else {
            for (let frame = this.baseFrame; frame < target; frame++) {
                const slot = frame % this.capacity;
                this.values[slot] = null;
                this.status[slot] = 'empty';
            }
        }
        this.baseFrame = target;
        if (this.confirmedHead < target)
            this.confirmedHead = target;
        this.advanceConfirmedHead();
    }
    advanceConfirmedHead() {
        while (this.confirmedHead < this.writtenHead) {
            const slot = this.confirmedHead % this.capacity;
            if (this.status[slot] !== 'confirmed')
                break;
            this.confirmedHead++;
        }
    }
    markDirty(frame) {
        if (frame < this.dirtyFrame)
            this.dirtyFrame = frame;
    }
    consumeDirty() {
        if (this.dirtyFrame === Infinity)
            return null;
        const f = this.dirtyFrame;
        this.dirtyFrame = Infinity;
        return f;
    }
    read(frame) {
        assertSafeFrame(frame);
        if (frame < this.startFrame || frame >= this.endFrame)
            return null;
        if (frame < this.baseFrame || frame >= this.baseFrame + this.capacity)
            return null;
        const slot = frame % this.capacity;
        return this.status[slot] === 'empty' ? null : this.values[slot];
    }
    frameStatus(frame) {
        assertSafeFrame(frame);
        if (frame < this.startFrame || frame >= this.endFrame)
            return 'empty';
        if (frame < this.baseFrame || frame >= this.baseFrame + this.capacity)
            return 'empty';
        return this.status[frame % this.capacity];
    }
    ensurePredicted(frame) {
        assertSafeFrame(frame);
        if (this.predictor === null)
            return;
        if (frame < this.startFrame)
            return;
        const target = Math.min(frame, this.endFrame - 1);
        let f = Math.max(this.confirmedHead, this.baseFrame);
        if (f > target)
            return;
        let prev = f > this.startFrame ? this.read(f - 1) : null;
        for (; f <= target; f++) {
            this.ensureCapacity(f);
            const slot = f % this.capacity;
            if (this.status[slot] !== 'empty') {
                prev = this.values[slot];
                continue;
            }
            const predicted = this.predictor(prev, f);
            if (predicted === null)
                return;
            this.predict(f, predicted);
            prev = predicted;
        }
    }
    invalidatePredictedFrom(frame) {
        assertSafeFrame(frame);
        if (frame >= this.writtenHead)
            return 0;
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
        if (lastWritten + 1 < this.writtenHead) {
            let newHead = this.writtenHead;
            while (newHead > start) {
                const slot = (newHead - 1) % this.capacity;
                if (this.status[slot] !== 'empty')
                    break;
                newHead--;
            }
            this.writtenHead = newHead;
        }
        return cleared;
    }
}
export class Capacitor {
    comparator;
    commits = [];
    clients = new Set();
    detachedDirtyFrame = Infinity;
    constructor(comparator) {
        this.comparator = comparator;
    }
    connect(props = {}) {
        const client = new Client({ ...props, comparator: this.comparator });
        this.clients.add(client);
        return client;
    }
    disconnect(client) {
        if (!this.clients.delete(client)) {
            return;
        }
        const dirtyFrame = client.consumeDirty();
        if (dirtyFrame !== null && dirtyFrame < this.detachedDirtyFrame) {
            this.detachedDirtyFrame = dirtyFrame;
        }
    }
    consumeDirty() {
        let earliest = this.detachedDirtyFrame;
        this.detachedDirtyFrame = Infinity;
        for (const client of this.clients) {
            const f = client.consumeDirty();
            if (f === null)
                continue;
            if (f < earliest)
                earliest = f;
        }
        return earliest === Infinity ? null : earliest;
    }
    trimBefore(frame) {
        assertSafeFrame(frame);
        for (const client of this.clients)
            client.trimBefore(frame);
    }
    ensurePredicted(frame) {
        assertSafeFrame(frame);
        for (const client of this.clients)
            client.ensurePredicted(frame);
    }
    invalidatePredictedFrom(frame) {
        assertSafeFrame(frame);
        for (const client of this.clients)
            client.invalidatePredictedFrom(frame);
    }
    resync(frame) {
        assertNonNegativeFrame(frame);
        this.detachedDirtyFrame = Infinity;
        for (const client of this.clients)
            client.resync(frame);
    }
    readConfirmed(frame) {
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
            if (status !== 'confirmed')
                ok = false;
        }
        if (!ok) {
            for (const client of this.clients)
                client.cache = null;
        }
        return ok;
    }
    read(frame) {
        return this.readConfirmed(frame);
    }
    readDetailed(frame) {
        assertSafeFrame(frame);
        const values = [];
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
            if (status !== 'confirmed')
                confirmed = false;
            if (status === 'empty')
                complete = false;
        }
        return {
            confirmed,
            complete,
            rollbackFrame: earliestDirty === Infinity ? null : earliestDirty,
            values,
        };
    }
    pendingClients(frame) {
        assertSafeFrame(frame);
        const pending = [];
        for (const client of this.clients) {
            if (frame >= client.endFrame)
                continue;
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
    clear() {
        this.clients.clear();
        this.commits = [];
        this.detachedDirtyFrame = Infinity;
    }
    size() {
        if (this.clients.size === 0)
            return 0;
        let size = Infinity;
        let completedEnd = 0;
        for (const client of this.clients) {
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
//# sourceMappingURL=capacitor.js.map