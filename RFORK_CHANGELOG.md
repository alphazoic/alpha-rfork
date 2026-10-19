# rfork changelog

## Unreleased

- Add opt-in bounded upload diagnostics with separate source, attempted payload,
  acknowledged data and final-commit status; omit private upload identifiers.

## v1.75.2-rfork.0.1.0-alpha.1

- Base the independent fork on the verified rclone 1.75.2 release.
- Upload native chunks of a single MEGA file concurrently, with a bounded
  producer and configurable worker count (`--mega-upload-concurrency`, 1–32).
- Enable HTTPS by default for MEGA transfers, preserving explicit overrides.
- Propagate cancellation through chunk requests, retry waits, API-lock waits
  and hashcash solving; join upload workers before returning.
- Retry identical ciphertext, validate complete chunk authentication before
  finalization, and prevent automatic replay after an uncertain final commit.
- Correct empty-file MAC generation and distinguish dash-prefixed opaque
  completion tokens from numeric MEGA errors.
- Add standalone builds, same-version stock comparison, fault/crypto/race
  checks, independent live integrity checks, benchmark runner and native CI.

This alpha does not change M3's bundled binaries or fallback selection.
