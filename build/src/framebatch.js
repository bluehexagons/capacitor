const assertNonNegativeSafeInteger = (name, value) => {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative safe integer`);
    }
};
const assertPositiveSafeInteger = (name, value) => {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive safe integer`);
    }
};
export const collectFrameBatch = ({ sources, originFrame, throughFrame, maxEntries, maxFrameSpan = maxEntries, }) => {
    assertNonNegativeSafeInteger('originFrame', originFrame);
    assertNonNegativeSafeInteger('throughFrame', throughFrame);
    assertPositiveSafeInteger('maxEntries', maxEntries);
    assertPositiveSafeInteger('maxFrameSpan', maxFrameSpan);
    if (throughFrame < originFrame) {
        throw new Error('throughFrame must be at or after originFrame');
    }
    if (sources.length === 0 || throughFrame === originFrame) {
        return { entries: [], sentThroughFrame: originFrame };
    }
    const fairFrameSpan = Math.max(1, Math.floor(maxEntries / sources.length));
    const frameSpan = Math.min(maxFrameSpan, fairFrameSpan);
    const entries = [];
    let sentThroughFrame = throughFrame;
    for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
        const source = sources[sourceIndex];
        assertNonNegativeSafeInteger(`sources[${sourceIndex}].startFrame`, source.startFrame);
        assertNonNegativeSafeInteger(`sources[${sourceIndex}].baseFrame`, source.baseFrame);
        assertNonNegativeSafeInteger(`sources[${sourceIndex}].confirmedHead`, source.confirmedHead);
        if (source.baseFrame < source.startFrame) {
            throw new Error(`sources[${sourceIndex}].baseFrame must be at or after startFrame`);
        }
        if (source.confirmedHead < source.startFrame) {
            throw new Error(`sources[${sourceIndex}].confirmedHead must be at or after startFrame`);
        }
        if (originFrame < source.baseFrame && source.baseFrame > source.startFrame) {
            throw new Error(`sources[${sourceIndex}] no longer retains originFrame`);
        }
        const start = Math.max(source.startFrame, source.baseFrame, originFrame);
        const end = Math.min(throughFrame, source.confirmedHead, originFrame + frameSpan);
        let sourceSentThroughFrame = Math.min(throughFrame, start);
        for (let frame = start; frame < end && entries.length < maxEntries; frame++) {
            const value = source.read(frame);
            if (value === null)
                break;
            entries.push({ sourceIndex, frame, frameOffset: frame - originFrame, value });
            sourceSentThroughFrame = frame + 1;
        }
        sentThroughFrame = Math.min(sentThroughFrame, sourceSentThroughFrame);
    }
    return { entries, sentThroughFrame };
};
export const applyFrameBatch = ({ targets, entries, originFrame, receivedThroughFrame, maxFrameLead, }) => {
    assertNonNegativeSafeInteger('originFrame', originFrame);
    assertNonNegativeSafeInteger('receivedThroughFrame', receivedThroughFrame);
    assertNonNegativeSafeInteger('maxFrameLead', maxFrameLead);
    for (const target of targets.values()) {
        assertNonNegativeSafeInteger('target.startFrame', target.startFrame);
        assertNonNegativeSafeInteger('target.confirmedHead', target.confirmedHead);
        if (target.confirmedHead < target.startFrame) {
            throw new Error('target.confirmedHead must be at or after startFrame');
        }
    }
    const acceptedEntries = [];
    const unknownTargetEntries = [];
    const staleEntries = [];
    const futureEntries = [];
    const invalidEntries = [];
    const rejectedEntries = [];
    const maximumAcceptedFrame = Math.min(Number.MAX_SAFE_INTEGER, receivedThroughFrame + maxFrameLead);
    let committedFrame = false;
    for (const entry of entries) {
        if (!Number.isSafeInteger(entry.frameOffset) || entry.frameOffset < 0) {
            invalidEntries.push(entry);
            continue;
        }
        const target = targets.get(entry.target);
        if (target === undefined) {
            unknownTargetEntries.push(entry);
            continue;
        }
        const localFrame = originFrame + entry.frameOffset;
        if (!Number.isSafeInteger(localFrame)) {
            invalidEntries.push(entry);
            continue;
        }
        if (localFrame < target.startFrame || localFrame < receivedThroughFrame) {
            staleEntries.push(entry);
            continue;
        }
        if (localFrame > maximumAcceptedFrame) {
            futureEntries.push(entry);
            continue;
        }
        const result = target.commit(localFrame, entry.value);
        if (result.kind === 'new' || result.kind === 'duplicate' || result.kind === 'corrected') {
            committedFrame = true;
            acceptedEntries.push({ entry, localFrame });
        }
        else {
            rejectedEntries.push(entry);
        }
    }
    let nextReceivedThroughFrame = receivedThroughFrame;
    if (committedFrame && targets.size > 0) {
        let minimumConfirmedHead = Number.POSITIVE_INFINITY;
        for (const target of targets.values()) {
            minimumConfirmedHead = Math.min(minimumConfirmedHead, target.confirmedHead);
        }
        nextReceivedThroughFrame = Math.max(receivedThroughFrame, minimumConfirmedHead);
    }
    return {
        receivedThroughFrame: nextReceivedThroughFrame,
        acceptedEntries,
        unknownTargetEntries,
        staleEntries,
        futureEntries,
        invalidEntries,
        rejectedEntries,
    };
};
//# sourceMappingURL=framebatch.js.map