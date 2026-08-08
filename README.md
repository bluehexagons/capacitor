# capacitor

Capacitor provides reusable frame-indexed input synchronization for lockstep
and rollback simulations. It owns bounded input history, prediction,
correction tracking, fair outgoing frame collection, and decoded-frame
application while leaving transport, authentication, and payload serialization
to the game.

## Installation

```bash
npm install https://codeload.github.com/bluehexagons/capacitor/tar.gz/refs/tags/v0.6.1
```

## Requirements

- Node.js >= 24.0.0

## Usage

```typescript
import { Capacitor } from '@bluehexagons/capacitor';

interface Packet {
  value: number;
}

const compare = (a: Packet, b: Packet) => a.value === b.value;

const cap = new Capacitor<unknown, Packet>(compare);
const client = cap.connect({ historyFrames: 1024 });

// Confirmed wire input lands as `commit`. The result tells you whether
// the simulation needs to roll back.
const result = client.commit(0, { value: 42 });
if (result.kind === 'corrected') {
  console.log('rollback to frame', result.rollbackFrame);
}

// Lockstep callers can still ask "did everyone produce frame N?".
if (cap.readConfirmed(0)) {
  console.log(client.cache);
}

// Rollback drivers prefer the structured read, plus draining the
// dirty-frame watermark across all clients.
const detailed = cap.readDetailed(0);
const rollback = cap.consumeDirty();
```

## Transport-neutral frame batches

`collectFrameBatch` fairly selects confirmed input from multiple sources while
respecting a total entry budget and an optional transport-specific frame span.
It reports progress only through the slowest fully represented source and fails
closed if the requested origin has already fallen out of a source's retained
history.
`applyFrameBatch` routes decoded entries to keyed clients, classifies unknown,
stale, future, invalid, and rejected input, and advances the shared contiguous
receive frontier.

```typescript
import { applyFrameBatch, collectFrameBatch } from '@bluehexagons/capacitor';

const outgoing = collectFrameBatch({
  sources: [client],
  originFrame: 120,
  throughFrame: 128,
  maxEntries: 255,
  maxFrameSpan: 255,
});

// Encode outgoing.entries with any wire format. After decoding on a peer:
const incoming = applyFrameBatch({
  targets: new Map([[playerID, client]]),
  entries: [{ target: playerID, frameOffset: 0, value: { value: 42 } }],
  originFrame: 120,
  receivedThroughFrame: 120,
  maxFrameLead: 255,
});
```

These helpers use ordinary TypeScript values and maps—there is no dependency on
Node `Buffer`, sockets, or a particular packet header—so games can use them in
browser, native-shell, client/server, or peer-to-peer transports.

## Version 0.6.x — what changed

Capacitor 0.6.0 adds transport-neutral outgoing frame collection and incoming
frame application. Antistatic's generic batching, commit classification, and
receive-frontier tests now live here; the game retains only its concrete input
serialization and game-specific packet envelope.

Capacitor 0.6.1 keeps shared outgoing progress behind the slowest contiguous
source, preserves pending correction state when a client disconnects, and
recovers confirmed progress immediately when the bounded window advances.

## Version 0.5.x — what changed

Capacitor 0.5.1 fixes bounded-window behavior for sparse writes and
predictions that extend beyond one ring capacity. It also validates frame
coordinates, makes deactivation monotonic, preserves dirty-frame reporting
for ended clients, exports the client option types, and adds automated
release/build consistency checks.

Capacitor 0.5.0 broadens the rollback / lockstep primitives so consumers
can drive both gameplay (prediction + rollback) and menu (neutral
fill) scenes through the same Capacitor APIs without bespoke buffer
peeking.

- `Predictor<V>` now receives the previous value (or `null`) and the absolute
  frame number. `ensurePredicted` invokes it even when
  there is no anchor at `frame - 1`, so cold-start predictors can
  synthesize a neutral default. Returning `null` from the predictor
  halts the fill without writing the slot.
- New `Client.commitIfEmpty(frame, value)` writes a confirmed value
  only if the slot is currently empty (returns `duplicate` for any
  existing predicted or confirmed value). Used to back-fill neutral
  inputs for network clients that have gone quiet without clobbering
  predictions.
- New `Client.hasValue(frame)` — `true` if the slot holds a confirmed
  or predicted value within the active window.
- New `Capacitor.pendingClients(frame)` returns the clients blocking
  `readConfirmed(frame)`. Inactive clients (`frame >= endFrame`) are
  excluded; not-yet-active clients (`frame < startFrame`) are
  included. Useful for diagnosing stalls.

## Version 0.4.x — what changed

Capacitor 0.4.0 replaces the lockstep-only sparse buffer with a
bounded ring buffer keyed by absolute frame, plus structured commit
results so a rollback driver can react to corrections without
inferring them from a bare boolean.

- `Client.commits` / `client.size` (legacy field) → ring-buffer
  storage. `client.size` is now a getter that reports the contiguous
  confirmed length; `client.commits` is gone.
- `Client.commit` returns `CommitResult`
  (`new` / `duplicate` / `corrected` / `stale` / `outside-window` /
  `inactive`) instead of a boolean.
- New `Client.predict(frame, value)` writes a prediction; a matching
  `commit` later upgrades it to confirmed without rollback, a
  mismatching one reports `corrected` and bumps the dirty watermark.
- New `Client.deactivate(frame)` and `endFrame` for clean disconnects.
- New `Client.trimBefore(frame)` and `Capacitor.trimBefore(frame)`
  for explicit window advancement.
- New `Capacitor.readDetailed(frame)` returns per-client status; the
  legacy `cap.read(frame)` is preserved as an alias for
  `readConfirmed`.
- `historyFrames` (default 1024) caps per-client memory.
- `sizeOffset` is renamed `startFrame`; `client.sizeOffset` is kept
  as a read-only alias. Same-version-only netplay means there is no
  bridging shim for the old commit return type.

## Development

```bash
# Install dependencies
npm install

# Build
npm run compile

# Run tests
npm test

# Run the full test, lint, and formatting gate
npm run check

# Lint
npm run lint

# Auto-fix linting and formatting issues
npm run fix

# Clean build artifacts
npm run clean
```

The repository includes checked-in build output under `build/src` so that Git-based installs work without requiring SSH or a package publish step.

## Release

Capacitor is consumed from GitHub tags. To release a new version:

1. Update `version` in `package.json` and `package-lock.json`.
2. Run `npm run check`.
3. Commit and push the version and build output changes to `main`.
4. Run `npm run release`.

The release script verifies the entire worktree is clean, checks that `v<version>` does not already exist locally or on `origin`, runs the full validation gate, confirms compilation did not change the checked-in build output, creates an annotated tag, and pushes the tag.

## License

Apache-2.0
