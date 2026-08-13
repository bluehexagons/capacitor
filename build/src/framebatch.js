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
    let participatingSources = 0;
    for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
        const source = sources[sourceIndex];
        assertNonNegativeSafeInteger(`sources[${sourceIndex}].startFrame`, source.startFrame);
        assertNonNegativeSafeInteger(`sources[${sourceIndex}].baseFrame`, source.baseFrame);
        assertNonNegativeSafeInteger(`sources[${sourceIndex}].confirmedHead`, source.confirmedHead);
        if (source.endFrame !== Infinity) {
            assertNonNegativeSafeInteger(`sources[${sourceIndex}].endFrame`, source.endFrame);
        }
        if (source.baseFrame < source.startFrame) {
            throw new Error(`sources[${sourceIndex}].baseFrame must be at or after startFrame`);
        }
        if (source.confirmedHead < source.startFrame) {
            throw new Error(`sources[${sourceIndex}].confirmedHead must be at or after startFrame`);
        }
        if (source.confirmedHead < source.baseFrame) {
            throw new Error(`sources[${sourceIndex}].confirmedHead must be at or after baseFrame`);
        }
        if (source.endFrame < source.startFrame) {
            throw new Error(`sources[${sourceIndex}].endFrame must be at or after startFrame`);
        }
        if (originFrame < source.baseFrame &&
            source.baseFrame > source.startFrame &&
            originFrame < source.endFrame) {
            throw new Error(`sources[${sourceIndex}] no longer retains originFrame`);
        }
        if (source.startFrame < throughFrame && source.endFrame > originFrame) {
            participatingSources++;
        }
    }
    if (participatingSources > maxEntries) {
        throw new Error('maxEntries must be at least the number of participating sources');
    }
    const fairFrameSpan = Math.max(1, Math.floor(maxEntries / Math.max(1, participatingSources)));
    const frameSpan = Math.min(maxFrameSpan, fairFrameSpan);
    const entries = [];
    let sentThroughFrame = throughFrame;
    for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
        const source = sources[sourceIndex];
        if (source.endFrame <= originFrame || source.startFrame >= throughFrame)
            continue;
        const start = Math.max(source.startFrame, source.baseFrame, originFrame);
        const end = Math.min(throughFrame, source.confirmedHead, source.endFrame, originFrame + frameSpan);
        let sourceSentThroughFrame = Math.min(throughFrame, start);
        for (let frame = start; frame < end && entries.length < maxEntries; frame++) {
            const value = source.read(frame);
            if (value === null)
                break;
            entries.push({ sourceIndex, frame, frameOffset: frame - originFrame, value });
            sourceSentThroughFrame = frame + 1;
        }
        if (sourceSentThroughFrame >= source.endFrame) {
            sourceSentThroughFrame = throughFrame;
        }
        sentThroughFrame = Math.min(sentThroughFrame, sourceSentThroughFrame);
    }
    return { entries, sentThroughFrame };
};
export const confirmedFrameFrontier = (targets, floor = 0) => {
    assertNonNegativeSafeInteger('floor', floor);
    let frontier = Number.POSITIVE_INFINITY;
    let completedEnd = floor;
    let found = false;
    for (const target of targets) {
        found = true;
        if (target.endFrame <= floor || target.confirmedHead >= target.endFrame) {
            if (target.endFrame !== Infinity)
                completedEnd = Math.max(completedEnd, target.endFrame);
            continue;
        }
        frontier = Math.min(frontier, target.confirmedHead);
    }
    if (frontier !== Number.POSITIVE_INFINITY)
        return Math.max(floor, frontier);
    return found ? Math.max(floor, completedEnd) : floor;
};
export const applyFrameBatch = ({ targets, entries, originFrame, receivedThroughFrame, maxFrameLead, }) => {
    assertNonNegativeSafeInteger('originFrame', originFrame);
    assertNonNegativeSafeInteger('receivedThroughFrame', receivedThroughFrame);
    assertNonNegativeSafeInteger('maxFrameLead', maxFrameLead);
    for (const target of targets.values()) {
        assertNonNegativeSafeInteger('target.startFrame', target.startFrame);
        assertNonNegativeSafeInteger('target.baseFrame', target.baseFrame);
        assertNonNegativeSafeInteger('target.confirmedHead', target.confirmedHead);
        assertPositiveSafeInteger('target.capacity', target.capacity);
        if (target.endFrame !== Infinity)
            assertNonNegativeSafeInteger('target.endFrame', target.endFrame);
        if (target.baseFrame < target.startFrame) {
            throw new Error('target.baseFrame must be at or after startFrame');
        }
        if (target.confirmedHead < target.startFrame) {
            throw new Error('target.confirmedHead must be at or after startFrame');
        }
        if (target.confirmedHead < target.baseFrame) {
            throw new Error('target.confirmedHead must be at or after baseFrame');
        }
        if (target.endFrame < target.startFrame) {
            throw new Error('target.endFrame must be at or after startFrame');
        }
    }
    const acceptedEntries = [];
    const unknownTargetEntries = [];
    const staleEntries = [];
    const futureEntries = [];
    const invalidEntries = [];
    const conflictEntries = [];
    const rejectedEntries = [];
    const maximumAcceptedFrame = Math.min(Number.MAX_SAFE_INTEGER, receivedThroughFrame + maxFrameLead);
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
        if (localFrame < target.startFrame ||
            localFrame < target.baseFrame ||
            localFrame < receivedThroughFrame ||
            localFrame >= target.endFrame) {
            staleEntries.push(entry);
            continue;
        }
        const retainedMaximumFrame = target.baseFrame + target.capacity - 1;
        if (localFrame > maximumAcceptedFrame || localFrame > retainedMaximumFrame) {
            futureEntries.push(entry);
            continue;
        }
        const result = target.commit(localFrame, entry.value);
        if (result.kind === 'new' || result.kind === 'duplicate' || result.kind === 'corrected') {
            acceptedEntries.push({ entry, localFrame });
        }
        else if (result.kind === 'conflict') {
            conflictEntries.push({ entry, localFrame, rollbackFrame: result.rollbackFrame });
        }
        else {
            rejectedEntries.push(entry);
        }
    }
    const nextReceivedThroughFrame = confirmedFrameFrontier(targets.values(), receivedThroughFrame);
    return {
        receivedThroughFrame: nextReceivedThroughFrame,
        acceptedEntries,
        unknownTargetEntries,
        staleEntries,
        futureEntries,
        invalidEntries,
        conflictEntries,
        rejectedEntries,
    };
};
//# sourceMappingURL=framebatch.js.map