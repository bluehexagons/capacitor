import { FrameExchangeProgress } from '../src/frameexchange.js';

describe('FrameExchangeProgress', () => {
  test('tracks send, receive, acknowledgement, and rebase frontiers', () => {
    const progress = new FrameExchangeProgress(10);
    expect(progress.needsFrames(11)).toBe(true);
    expect(progress.markSent(14)).toBe(true);
    expect(progress.selectSendOrigin(2)).toBe(12);
    expect(progress.acceptAcknowledgement(13, 20)).toBe('advanced');
    expect(progress.acceptAcknowledgement(13, 20)).toBe('duplicate');
    expect(progress.acceptAcknowledgement(30, 20)).toBe('impossible');
    progress.rewindSendToAcknowledged(1);
    expect(progress.sentThroughFrame).toBe(12);

    progress.markReceived(12);
    expect(progress.needsAcknowledgement()).toBe(true);
    expect(progress.markAcknowledgementSent(11)).toBe(true);
    expect(progress.needsAcknowledgement()).toBe(true);
    progress.markReceived(14);
    const revision = progress.revision;
    expect(progress.markAcknowledgementSent(12, revision)).toBe(true);
    expect(progress.lastAcknowledgedThroughFrame).toBe(12);
    expect(progress.markAcknowledgementSent(14)).toBe(true);
    expect(progress.needsAcknowledgement()).toBe(false);
    expect(progress.markAcknowledgementSent(15)).toBe(false);

    progress.rebase(100);
    expect(progress).toMatchObject({
      originFrame: 100,
      sentThroughFrame: 100,
      acknowledgedThroughFrame: 100,
      receivedThroughFrame: 100,
      lastAcknowledgedThroughFrame: 100,
    });
    expect(progress.markSent(14, revision)).toBe(false);
    expect(progress.markAcknowledgementSent(14, revision)).toBe(false);
  });
});
