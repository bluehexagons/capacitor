# Repository Guidelines

## Structure and generated output

Capacitor is a TypeScript rollback/input synchronization package. Source lives
under `src/` and tests under `test/`; compiled package output under `build/src/`
is tracked for immutable Git-tag installs, while `build/test/` is disposable. Keep
transport, authentication, serialization, and game simulation policy outside
this package.

## Environment and commands

The standard Linux host is a Basaltwater-managed agent VM. Node 24+ is
required; related repositories normally live beside this checkout below
`~/repos`.

Select `.nvmrc` with `nvm use` before npm commands. On Basaltwater,
`basaltw node exec -- npm run check` selects the project runtime without
changing the host default; `basaltw node install` installs a missing pin.

- `npm ci`: install dependencies.
- `npm run check`: compile, test, lint, and verify formatting.
- `npm run test`: compile and run the Node.js test suite.
- `npm run fix`: apply lint and formatting fixes.

After changes that affect emitted code, run `npm run check`, inspect the
resulting `build/src` diff, and include intentional generated updates with the
source change. A clean checkout should still pass
`git diff --exit-code -- build/src` after the gate. Keep reports and scratch
evidence under ignored `local-artifacts/`.

## Releases

Use `npm run release` and the adjacent Antistatic repository's
`sister-repository-maintenance` guidance. Never move a published tag or point a
consumer at an unpublished branch. AI-assisted commits append `w/llm`.
