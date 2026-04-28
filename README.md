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

// Define your packet type
interface Packet {
  value: number;
}

// Create a comparator function
const compare = (a: Packet, b: Packet) => a.value === b.value;

// Create a new Capacitor instance
const cap = new Capacitor<any, Packet>(compare);

// Connect clients
const client = cap.connect({});

// Commit values
client.commit(0, { value: 42 });

// Read values
const value = client.read(0);
console.log(value); // { value: 42 }
```

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
