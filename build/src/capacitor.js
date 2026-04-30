const defaultComparator = (_a, _b) => true;
const DEFAULT_HISTORY_FRAMES = 1024;
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
        this.values = new Array(historyFrames).fill(null);
        this.status = new Array(historyFrames).fill('empty');
    }
    deactivate(frame) {
        this.endFrame = frame;
    }
    trimBefore(frame) {
        const target = Math.min(frame, this.writtenHead);
        while (this.baseFrame < target) {
            const slot = this.baseFrame % this.capacity;
            this.values[slot] = null;
            this.status[slot] = 'empty';
            this.baseFrame++;
        }
    }
    commit(frame, value) {
        return this.write(frame, value, 'confirmed');
    }
    predict(frame, value) {
        if (frame < this.startFrame)
            return { kind: 'stale' };
        if (frame >= this.endFrame)
            return { kind: 'inactive' };
        if (frame < this.baseFrame)
            return { kind: 'outside-window' };
        this.ensureCapacity(frame);
        const slot = frame % this.capacity;
        if (this.status[slot] === 'confirmed') {
            const existing = this.values[slot];
            if (this.comparator(existing, value))
                return { kind: 'duplicate' };
            return { kind: 'corrected', rollbackFrame: frame };
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
            this.trimBefore(this.baseFrame + overflow);
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
        if (frame < this.startFrame || frame >= this.endFrame)
            return null;
        if (frame < this.baseFrame || frame >= this.baseFrame + this.capacity)
            return null;
        const slot = frame % this.capacity;
        return this.status[slot] === 'empty' ? null : this.values[slot];
    }
    frameStatus(frame) {
        if (frame < this.startFrame || frame >= this.endFrame)
            return 'empty';
        if (frame < this.baseFrame || frame >= this.baseFrame + this.capacity)
            return 'empty';
        return this.status[frame % this.capacity];
    }
    ensurePredicted(frame) {
        if (this.predictor === null)
            return;
        if (frame < this.startFrame)
            return;
        const target = Math.min(frame, this.endFrame - 1);
        let f = this.confirmedHead;
        if (f > target)
            return;
        let prev = f > this.startFrame ? this.read(f - 1) : null;
        for (; f <= target; f++) {
            const slot = f % this.capacity;
            if (this.status[slot] !== 'empty') {
                prev = this.values[slot];
                continue;
            }
            if (prev === null)
                return;
            const predicted = this.predictor(prev, f);
            this.predict(f, predicted);
            prev = predicted;
        }
    }
}
export class Capacitor {
    comparator;
    commits = [];
    clients = new Set();
    constructor(comparator) {
        this.comparator = comparator;
    }
    connect(props) {
        const client = new Client({ comparator: this.comparator, ...props });
        this.clients.add(client);
        return client;
    }
    disconnect(client) {
        this.clients.delete(client);
    }
    consumeDirty() {
        let earliest = null;
        for (const client of this.clients) {
            const f = client.consumeDirty();
            if (f === null)
                continue;
            if (earliest === null || f < earliest)
                earliest = f;
        }
        return earliest;
    }
    trimBefore(frame) {
        for (const client of this.clients)
            client.trimBefore(frame);
    }
    ensurePredicted(frame) {
        for (const client of this.clients)
            client.ensurePredicted(frame);
    }
    readConfirmed(frame) {
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
        const values = [];
        let confirmed = true;
        let complete = true;
        let earliestDirty = null;
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
            if (status !== 'confirmed')
                confirmed = false;
            if (status === 'empty')
                complete = false;
            if (client.dirtyFrame !== Infinity) {
                if (earliestDirty === null || client.dirtyFrame < earliestDirty) {
                    earliestDirty = client.dirtyFrame;
                }
            }
        }
        return { confirmed, complete, rollbackFrame: earliestDirty, values };
    }
    clear() {
        this.clients.clear();
        this.commits = [];
    }
    size() {
        if (this.clients.size === 0)
            return 0;
        let size = Infinity;
        for (const client of this.clients) {
            if (client.endFrame === client.startFrame)
                continue;
            size = Math.min(size, client.confirmedHead);
        }
        return size === Infinity ? 0 : size;
    }
}
//# sourceMappingURL=capacitor.js.map