# Changelog

## 0.7.2

- Preserve unsent frame and acknowledgment work until the transport confirms
  success, and ignore late transport callbacks after progress resets.
- Report immutable confirmed-input conflicts separately from ordinary target
  rejections so consumers can fail closed.
- Treat entries behind a target's retained window as stale while advancing from
  its confirmed frontier metadata.
- Preserve conflict rollback frames in applied batch results for consumer
  diagnostics or recovery policies.

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
