const assertFrame = (name, frame) => {
    if (!Number.isSafeInteger(frame) || frame < 0) {
        throw new Error(`${name} must be a non-negative safe integer`);
    }
};
export class FrameExchangeProgress {
    originFrame;
    sentThroughFrame;
    acknowledgedThroughFrame;
    receivedThroughFrame;
    lastAcknowledgedThroughFrame;
    constructor(originFrame = 0) {
        assertFrame('originFrame', originFrame);
        this.originFrame = originFrame;
        this.sentThroughFrame = originFrame;
        this.acknowledgedThroughFrame = originFrame;
        this.receivedThroughFrame = originFrame;
        this.lastAcknowledgedThroughFrame = originFrame;
    }
    reset(frame = this.originFrame) {
        assertFrame('frame', frame);
        this.sentThroughFrame = frame;
        this.acknowledgedThroughFrame = frame;
        this.receivedThroughFrame = frame;
        this.lastAcknowledgedThroughFrame = frame;
        return this;
    }
    rebase(frame) {
        assertFrame('frame', frame);
        this.originFrame = frame;
        return this.reset(frame);
    }
    selectSendOrigin(backFrames) {
        assertFrame('backFrames', backFrames);
        return Math.max(this.originFrame, this.sentThroughFrame - backFrames);
    }
    needsFrames(throughFrame) {
        assertFrame('throughFrame', throughFrame);
        return throughFrame > this.sentThroughFrame;
    }
    needsAcknowledgement() {
        return this.receivedThroughFrame > this.lastAcknowledgedThroughFrame;
    }
    markSent(throughFrame) {
        assertFrame('throughFrame', throughFrame);
        this.sentThroughFrame = Math.max(this.sentThroughFrame, throughFrame);
    }
    markReceived(throughFrame) {
        assertFrame('throughFrame', throughFrame);
        this.receivedThroughFrame = Math.max(this.receivedThroughFrame, throughFrame);
    }
    markAcknowledgementSent() {
        this.lastAcknowledgedThroughFrame = this.receivedThroughFrame;
    }
    acceptAcknowledgement(throughFrame, maximumThroughFrame) {
        assertFrame('throughFrame', throughFrame);
        assertFrame('maximumThroughFrame', maximumThroughFrame);
        if (throughFrame > maximumThroughFrame)
            return 'impossible';
        if (throughFrame <= this.acknowledgedThroughFrame)
            return 'duplicate';
        this.acknowledgedThroughFrame = throughFrame;
        this.sentThroughFrame = Math.max(this.sentThroughFrame, throughFrame);
        return 'advanced';
    }
    rewindSendToAcknowledged(overlapFrames = 0) {
        assertFrame('overlapFrames', overlapFrames);
        this.sentThroughFrame = Math.max(this.originFrame, this.acknowledgedThroughFrame - overlapFrames);
    }
}
//# sourceMappingURL=frameexchange.js.map