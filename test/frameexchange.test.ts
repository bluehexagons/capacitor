import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { FrameExchangeProgress } from '../src/frameexchange.js';

describe('FrameExchangeProgress', () => {
  test('tracks send, receive, acknowledgement, and rebase frontiers', () => {
    const progress = new FrameExchangeProgress(10);
    assert.strictEqual(progress.needsFrames(11), true);
    assert.strictEqual(progress.markSent(14), true);
    assert.strictEqual(progress.selectSendOrigin(2), 12);
    assert.strictEqual(progress.acceptAcknowledgement(13, 20), 'advanced');
    assert.strictEqual(progress.acceptAcknowledgement(13, 20), 'duplicate');
    assert.strictEqual(progress.acceptAcknowledgement(30, 20), 'impossible');
    progress.rewindSendToAcknowledged(1);
    assert.strictEqual(progress.sentThroughFrame, 12);

    progress.markReceived(12);
    assert.strictEqual(progress.needsAcknowledgement(), true);
    assert.strictEqual(progress.markAcknowledgementSent(11), true);
    assert.strictEqual(progress.needsAcknowledgement(), true);
    progress.markReceived(14);
    const revision = progress.revision;
    assert.strictEqual(progress.markAcknowledgementSent(12, revision), true);
    assert.strictEqual(progress.lastAcknowledgedThroughFrame, 12);
    assert.strictEqual(progress.markAcknowledgementSent(14), true);
    assert.strictEqual(progress.needsAcknowledgement(), false);
    assert.strictEqual(progress.markAcknowledgementSent(15), false);

    progress.rebase(100);
    assert.partialDeepStrictEqual(progress, {
      originFrame: 100,
      sentThroughFrame: 100,
      acknowledgedThroughFrame: 100,
      receivedThroughFrame: 100,
      lastAcknowledgedThroughFrame: 100,
    });
    assert.strictEqual(progress.markSent(14, revision), false);
    assert.strictEqual(progress.markAcknowledgementSent(14, revision), false);
  });
});
