# Changelog

## 0.7.0

- Add lifecycle- and retained-window-aware frame batching.
- Reject confirmed-input conflicts by default.
- Add client-associated frame resolution, generic rollback snapshot storage,
  correction retention, and peer frame-progress utilities.
- Remove the unused `Capacitor` state generic and `commits` array.

## 0.6.x

- Add transport-neutral outgoing collection and incoming application.
- Keep shared progress behind the slowest source and preserve dirty state when
  clients disconnect.

## 0.5.x

- Add cold-start predictors, neutral backfill, pending-client diagnostics, and
  bounded-window hardening.

## 0.4.x

- Replace sparse storage with a bounded ring buffer and add prediction,
  correction, deactivation, trimming, resynchronization, and structured reads.
