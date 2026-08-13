export type AcknowledgementResult = 'advanced' | 'duplicate' | 'impossible';
export declare class FrameExchangeProgress {
    private progressRevision;
    originFrame: number;
    sentThroughFrame: number;
    acknowledgedThroughFrame: number;
    receivedThroughFrame: number;
    lastAcknowledgedThroughFrame: number;
    constructor(originFrame?: number);
    reset(frame?: number): this;
    rebase(frame: number): this;
    selectSendOrigin(backFrames: number): number;
    needsFrames(throughFrame: number): boolean;
    needsAcknowledgement(): boolean;
    get revision(): number;
    markSent(throughFrame: number, revision?: number): boolean;
    markReceived(throughFrame: number): void;
    markAcknowledgementSent(throughFrame?: number, revision?: number): boolean;
    acceptAcknowledgement(throughFrame: number, maximumThroughFrame: number): AcknowledgementResult;
    rewindSendToAcknowledged(overlapFrames?: number): void;
}
