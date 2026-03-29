# capacitor

Capacitor is a purpose-built FIFO interpolation-friendly server-client model synchronization utility.

## Installation

```bash
npm install git+https://github.com/bluehexagons/capacitor.git
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

## License

GPL-3.0
