import { FrameExchangeProgress } from '../src/frameexchange.js';

describe('FrameExchangeProgress', () => {
  test('tracks send, receive, acknowledgement, and rebase frontiers', () => {
    const progress = new FrameExchangeProgress(10);
    expect(progress.needsFrames(11)).toBe(true);
    progress.markSent(14);
    expect(progress.selectSendOrigin(2)).toBe(12);
    expect(progress.acceptAcknowledgement(13, 20)).toBe('advanced');
    expect(progress.acceptAcknowledgement(13, 20)).toBe('duplicate');
    expect(progress.acceptAcknowledgement(30, 20)).toBe('impossible');
    progress.rewindSendToAcknowledged(1);
    expect(progress.sentThroughFrame).toBe(12);

    progress.markReceived(12);
    expect(progress.needsAcknowledgement()).toBe(true);
    progress.markAcknowledgementSent();
    expect(progress.needsAcknowledgement()).toBe(false);

    progress.rebase(100);
    expect(progress).toMatchObject({
      originFrame: 100,
      sentThroughFrame: 100,
      acknowledgedThroughFrame: 100,
      receivedThroughFrame: 100,
      lastAcknowledgedThroughFrame: 100,
    });
  });
});
