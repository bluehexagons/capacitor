export type AcknowledgementResult = 'advanced' | 'duplicate' | 'impossible';
export declare class FrameExchangeProgress {
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
    markSent(throughFrame: number): void;
    markReceived(throughFrame: number): void;
    markAcknowledgementSent(): void;
    acceptAcknowledgement(throughFrame: number, maximumThroughFrame: number): AcknowledgementResult;
    rewindSendToAcknowledged(overlapFrames?: number): void;
}
