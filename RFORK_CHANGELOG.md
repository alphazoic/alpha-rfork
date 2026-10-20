# rfork changelog

## Unreleased

- Add experimental `backend upload-resume` for an explicit local regular file,
  using account-bound encrypted checkpoints, private native storage/locking,
  preflight block fingerprints, skipped-chunk MAC verification and coalesced
  writes. Persist commit intent before finalization and keep a committed node
  tombstone; uncertain outcomes stop for inspection without automatic replay.
- Add cancellable explicit payload accounting for resume; restored bytes and
  preflight/skipped reads do not consume the current attempt's bandwidth budget.
  Integrated live recovery remains a release gate.
- Preserve non-retryable finalization errors through CLI exit classification,
  even when the underlying lost-response cause is a transient EOF or timeout.
- Add opt-in bounded upload diagnostics with separate source, attempted payload,
  acknowledged data and final-commit status; omit private upload identifiers.
- Classify chunk failures, retry transient MEGA/HTTP errors with bounded jittered
  backoff, respect Retry-After, avoid retrying permanent errors, bound response
  sizes and omit private upload URLs from data-request errors.
- Expose per-file additional retry budgets and experimental response-body replay;
  preserve the guard against replaying an uncertain final commit.
- Add configurable data pacing (`--mega-upload-pacing`, default 10ms, 0 to disable),
  including retries, independently of API pacing. Preserve shared foreground
  connection admission and make upload pacing/admission waits cancellable.
- Add opt-in HTTP request grouping (`--mega-upload-request-size`, 0 or 1–64 MiB),
  retaining native chunk encryption/MAC boundaries, bounded workers+1 payload
  buffers and ordinary MEGA files. Preserve native requests by default.
- Preserve zero-length POST framing when collecting upload diagnostics.

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
