# capacitor

Capacitor provides bounded, frame-indexed input synchronization primitives for
lockstep and rollback simulations. It owns input history, prediction,
correction tracking, frame batching, rollback snapshot metadata, and peer frame
progress. Games retain transport, authentication, serialization, snapshots,
and simulation policy.

## Install

```bash
npm install https://codeload.github.com/bluehexagons/capacitor/tar.gz/refs/tags/v0.7.0
```

The supported Node.js runtime is 24 or newer. Runtime modules use ordinary
ECMAScript values and contain no Node APIs, so they can also be bundled for
modern browsers and native shells.

## Lockstep

```typescript
import { Capacitor } from '@bluehexagons/capacitor';

type Input = { buttons: number };
const inputsEqual = (a: Input, b: Input) => a.buttons === b.buttons;
const inputs = new Capacitor<Input>(inputsEqual);
const player = inputs.connect({ historyFrames: 1024 });

player.commit(0, { buttons: 1 });
if (inputs.readConfirmed(0)) {
  simulate(player.cache!);
}
```

## Rollback

Predictions are provisional. A mismatching confirmation returns `corrected`
and records the earliest dirty frame. Confirmed input is immutable by default;
a second, different confirmed value returns `conflict` without replacing it.

```typescript
const remote = inputs.connect({
  predictor: (previous) => previous ?? { buttons: 0 },
});

const resolved = inputs.resolveFrame(frame, {
  predict: true,
  maxPredictionLead: 8,
});
if (resolved.complete) {
  saveSnapshot(frame);
  simulate(resolved.clients.map((result) => result.value!));
}

const dirty = inputs.consumeDirty();
if (dirty !== null) {
  inputs.invalidatePredictedFrom(dirty);
  restoreSnapshot(dirty);
  replay(dirty, frame);
}
```

`RollbackRing` supplies bounded snapshot indexing and unsafe-boundary metadata
while callbacks keep the snapshot representation game-owned.

## Frame coordinates

| Name            | Meaning                                |
| --------------- | -------------------------------------- |
| `startFrame`    | First participating frame, inclusive   |
| `endFrame`      | Last participating frame, exclusive    |
| `baseFrame`     | Oldest retained frame                  |
| `confirmedHead` | First frame not contiguously confirmed |
| `writtenHead`   | First frame beyond every stored value  |

Clients before `startFrame` block lockstep reads because their participation is
pending. Clients at or beyond `endFrame` are complete and do not block reads or
batch frontiers.

## Transport-neutral batches

`collectFrameBatch` selects confirmed input fairly from active sources.
`applyFrameBatch` classifies decoded input and advances the shared confirmed
frontier. `FrameExchangeProgress` tracks the per-peer send, acknowledgement,
receive, and rebase cursors around those helpers.

```typescript
const outgoing = collectFrameBatch({
  sources: [player],
  originFrame: progress.selectSendOrigin(2),
  throughFrame: frame,
  maxEntries: 255,
  maxFrameSpan: 255,
});
progress.markSent(outgoing.sentThroughFrame);

const incoming = applyFrameBatch({
  targets: new Map([[playerID, remote]]),
  entries: decodedEntries,
  originFrame: decodedOrigin,
  receivedThroughFrame: progress.receivedThroughFrame,
  maxFrameLead: 255,
});
progress.markReceived(incoming.receivedThroughFrame);
```

Batching invariants:

- `maxEntries` must cover every source participating in the requested span.
- A target rejects input that would evict unresolved retained history.
- Remove or deactivate participants at their exclusive `endFrame`.
- Treat `conflict` as a protocol error unless legacy replacement was explicitly enabled.
- Encode authentication, checksums, epochs, and payloads outside this package.

## Development

```bash
npm install
npm run check
```

Checked-in output under `build/src` supports Git-tag installs. See
[CHANGELOG.md](CHANGELOG.md) for release history. Releases update both lockfile
versions, run `npm run check`, commit generated output, then run
`npm run release`.

Apache-2.0
