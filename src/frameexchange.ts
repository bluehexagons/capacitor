const assertFrame = (name: string, frame: number): void => {
  if (!Number.isSafeInteger(frame) || frame < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
};

export type AcknowledgementResult = 'advanced' | 'duplicate' | 'impossible';

/** Transport-neutral progress cursors for one remote frame stream. */
export class FrameExchangeProgress {
  originFrame: number;
  sentThroughFrame: number;
  acknowledgedThroughFrame: number;
  receivedThroughFrame: number;
  lastAcknowledgedThroughFrame: number;

  constructor(originFrame = 0) {
    assertFrame('originFrame', originFrame);
    this.originFrame = originFrame;
    this.sentThroughFrame = originFrame;
    this.acknowledgedThroughFrame = originFrame;
    this.receivedThroughFrame = originFrame;
    this.lastAcknowledgedThroughFrame = originFrame;
  }

  reset(frame = this.originFrame): this {
    assertFrame('frame', frame);
    this.sentThroughFrame = frame;
    this.acknowledgedThroughFrame = frame;
    this.receivedThroughFrame = frame;
    this.lastAcknowledgedThroughFrame = frame;
    return this;
  }

  rebase(frame: number): this {
    assertFrame('frame', frame);
    this.originFrame = frame;
    return this.reset(frame);
  }

  selectSendOrigin(backFrames: number): number {
    assertFrame('backFrames', backFrames);
    return Math.max(this.originFrame, this.sentThroughFrame - backFrames);
  }

  needsFrames(throughFrame: number): boolean {
    assertFrame('throughFrame', throughFrame);
    return throughFrame > this.sentThroughFrame;
  }

  needsAcknowledgement(): boolean {
    return this.receivedThroughFrame > this.lastAcknowledgedThroughFrame;
  }

  markSent(throughFrame: number): void {
    assertFrame('throughFrame', throughFrame);
    this.sentThroughFrame = Math.max(this.sentThroughFrame, throughFrame);
  }

  markReceived(throughFrame: number): void {
    assertFrame('throughFrame', throughFrame);
    this.receivedThroughFrame = Math.max(this.receivedThroughFrame, throughFrame);
  }

  markAcknowledgementSent(): void {
    this.lastAcknowledgedThroughFrame = this.receivedThroughFrame;
  }

  acceptAcknowledgement(throughFrame: number, maximumThroughFrame: number): AcknowledgementResult {
    assertFrame('throughFrame', throughFrame);
    assertFrame('maximumThroughFrame', maximumThroughFrame);
    if (throughFrame > maximumThroughFrame) return 'impossible';
    if (throughFrame <= this.acknowledgedThroughFrame) return 'duplicate';
    this.acknowledgedThroughFrame = throughFrame;
    this.sentThroughFrame = Math.max(this.sentThroughFrame, throughFrame);
    return 'advanced';
  }

  rewindSendToAcknowledged(overlapFrames = 0): void {
    assertFrame('overlapFrames', overlapFrames);
    this.sentThroughFrame = Math.max(
      this.originFrame,
      this.acknowledgedThroughFrame - overlapFrames
    );
  }
}
