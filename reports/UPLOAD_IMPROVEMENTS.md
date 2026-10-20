# Upload improvement validation

Work begins from saved commit `2500ccc2fe0e117a95df1860355c1483408291a7`.
The baseline release and M3 bundles remain unchanged. This record distinguishes
offline checks from live-server and native-platform validation.

## Diagnostics stage — 2026-10-20

Implemented `--mega-upload-diagnostics` (default false). It emits bounded numeric
aggregates through the `megaUpload` JSON-log field. Counts distinguish source
reads, HTTP payload reads including retries, acknowledged native chunks and file
commit success. Durations include source reads, encryption, HTTP requests,
responses and retry waits; upload setup/data/commit/elapsed timings have explicit
boundaries. Worker durations overlap. No private upload identifiers are recorded.
CPU/RSS and TCP/TLS traffic remain external measurements. Pacing timing is reserved
for the separate data-pacing implementation.

Validation on Linux:

- Added diagnostics contract tests before implementation; the initial run failed
  to compile because the new APIs did not exist.
- Dependency crypto/HTTP/race suite passed, including retry byte accounting,
  disabled collection, private-field exclusion and parallel aggregate bounds.
- Backend upload race tests passed, including short-source diagnostic accounting
  and the existing worker cancellation/finalization checks.
- `bin/lint-rfork` passed for parent packages and local-dependency changes.
- `git diff --check` passed.

Commands: `bin/rfork-go test -race -count=1 -timeout 90s ./backend/mega -run
'^TestUpload'`; in `deps/go-mega`, `bin/rfork-go test -race -count=1 -timeout 90s
./...` via `RFORK_WORKDIR`; and `bin/lint-rfork`.

The HTTP fixture suite required execution outside the filesystem sandbox because
the sandbox denied localhost socket listeners. No live MEGA uploads, performance
claims or new Windows/macOS runtime validation are covered by this stage.

## Chunk recovery stage — 2026-10-20

Regression tests first reproduced three existing failures: a 403 was attempted
three times, MEGA `-3` was not retried, and a transport failure printed the upload
URL. The implementation now classifies transient versus permanent failures,
retries identical ciphertext with a per-file budget, respects Retry-After with
cancellable jittered waits, caps response bodies at 4 KiB and sanitizes request
errors while preserving known provider descriptions and programmatic causes.

New CLI controls are `--mega-upload-retries` (additional attempts; -1 inherits
low-level retries) and `--mega-upload-retry-body-errors` (experimental, false by
default). Body-error replay is deliberately not enabled by default: a fixture
proves client behavior but cannot prove live terminal-response replay semantics.
No final-commit replay is added.

The same dependency race suite and parent lint commands passed. New tests cover
permanent HTTP errors, temporary/permanent provider errors, retry ciphertext
identity, body-error replay opt-in, exhausted budgets, Retry-After parsing and
cancellation, bounded responses and URL exclusion. Backend worker race tests also
passed. Live MEGA behavior and native Windows/macOS runtime checks remain pending.

## Separate data pacing stage — 2026-10-20

Implemented `--mega-upload-pacing`: arbitrary nonnegative durations, compatibility
default 10ms, and 0 for unpaced data starts. The limiter is per backend, shared
across its files, and independent of metadata/API pacing. A request hook covers
every attempt, including retries, and releases admission after response close or
failure. Foreground API operations and data requests share the configured
`--max-connections` bound. Data pacing/admission waits cancel without reserving
future request slots. Per-account client caching does not store these settings.

Focused backend and dependency race suites passed. Added tests cover spacing,
zero pacing, cancellation, cancelled-slot reuse, retry hooks, hook release,
connection admission across uploads/API calls and invalid option rejection before
login. Parent/dependency lint and whitespace checks are also required before this
stage's commit. No worker-count or configurable-setting performance sweep was run.
The development version is 0.2.0-dev; the saved alpha tag/bundles are preserved.

## Broader checks and batching protocol prototype — 2026-10-20

The Linux 0.2.0-dev CLI built from `12a5690`, exposed all four new flags in backend
help, and passed local copy/flag-parsing smoke checks. Its SHA-256 is recorded in
`upload-improvements-cli.json`. The original three build outputs were separately
preserved under ignored `build/baseline-2500ccc/`; M3 bundles still match their
saved manifest.

Backend, operations, accounting and HTTP package tests passed with cloud config
disabled. The dependency range prototype then passed the complete focused crypto/
HTTP/race suite, including the existing independent native MAC/decryption checks.
See `UPLOAD_PROTOCOL.md` for the prototype and manual live gate. A dependency test
initially used a Go 1.25 WaitGroup helper; lint correctly rejected it against the
dependency's Go 1.24 module contract, and it was replaced with Add/Done.

Live batching/offset replay, full native suites, restart resume and release
promotion remain pending. Backend request batching is intentionally not yet wired.

## Empty diagnostic request correction — 2026-10-20

Native-check preparation exposed that wrapping Go's `http.NoBody` changed an
empty upload from a zero-length POST to chunked/unknown-length framing. A new
HTTP fixture rejected the instrumented request before the fix. Diagnostic body
counters now preserve NoBody identity, including replay-body creation. The full
dependency race suite and parent/dependency lint passed after correction. This
fix does not change normal nonempty payload framing or M3 bundles.

## Bounded backend request grouping — 2026-10-20

The manual live protocol gate passed at `2f644d1`: batching, accepted nonterminal
offset replay, usable terminal-handle replay, independent stock-client hashes
and verified cleanup. Receipt: `upload-protocol-39397241665.json`.

The backend now exposes `--mega-upload-request-size` (0 or 1–64 MiB), retaining
native requests by default. Complete contiguous native chunks form one owned
request job. The producer has no queued batches beyond the workers plus one;
retry ciphertext stays immutable and finalization still follows joined workers.
Diagnostics report the configured size. Explicit CLI units avoid rclone's bare
number KiB convention. Buffer bounds include separate crypto/MAC/read/transport
overhead, as described in the option help and README.

Backend and dependency race suites passed. New tests cover grouping/content,
varying initial chunk boundaries, disabled grouping, tiny/empty files, source
short reads, failed batches, peer cancellation/joining, unsupported sessions,
invalid settings before source reads/login and workers+1 read-ahead. Related
backend/operations/accounting/HTTP package tests passed after grouping was added.
Parent/dependency lint, Python runner fixtures and workflow YAML parsing passed.
Runner fixtures first reproduced and then corrected a byte-unit argument error.

[Native CI run 39397012952](https://github.com/mega-fork/rfork/actions/runs/39397012952)
passed on Linux, Windows and macOS for the earlier dependency-prototype commit
`2f644d1` (full upstream units, focused races, CLI builds/smoke). This does not
substitute for the final backend-batching commit's checks.

The manual workflow's `improvements` choice validates the actual CLI on all three
native platforms, sequentially against the dedicated account. It checks grouping
through the maximum accepted request size, effective diagnostic settings, explicit
connection limits, independent hashes, empty/boundary files, replacement, multiple
files and cancellation. It publishes sanitized receipts and always retries scoped
cleanup. It is not a performance-ranking matrix. Those final native/live results,
restart resume and standalone release promotion remain pending.
