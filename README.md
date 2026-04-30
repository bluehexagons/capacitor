# capacitor

Capacitor is a purpose-built FIFO interpolation-friendly server-client model synchronization utility.

## Installation

```bash
npm install https://codeload.github.com/bluehexagons/capacitor/tar.gz/refs/tags/v0.3.5
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
2. Run `npm test`.
3. Commit the version and build output changes.
4. Run `npm run release`.

The release script verifies the tracked worktree is clean, checks that `v<version>` does not already exist locally or on `origin`, reruns `npm test`, creates an annotated tag, and pushes the tag.

## License

GPL-3.0
