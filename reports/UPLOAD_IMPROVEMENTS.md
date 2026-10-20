# Upload improvement validation

Work begins from saved commit `2500ccc2fe0e117a95df1860355c1483408291a7`.
The baseline release and M3 bundles remain unchanged. This record distinguishes
offline checks from live-server and native-platform validation.

## Current status

Implementation source: `464acac3b33b829e5e10808ba128520cde3c17a8` on
`codex/rfork-upload-plan`, development version `0.2.0-dev`. Diagnostics, per-file
chunk retry controls, separate data pacing and configurable request grouping are
implemented. Compatibility defaults retain 8 workers, 10ms data pacing, native
requests and opt-in response-body replay. No performance-setting sweep was run.

- Focused backend/dependency race suites, related operations/accounting/HTTP
  package tests, lint and six offline runner fixtures passed.
- The live protocol gate passed batching, offset replay, terminal-handle recovery,
  independent hashes and cleanup at `2f644d1`. It is not a substitute for the
  integrated final CLI validation.
- Linux, Windows and macOS amd64 native full unit suites, upload/dependency races,
  builds and CLI smoke checks passed in the temporary repository at `b4bd97c`, whose
  upload implementation matches `464acac`. Linux lint and runner fixtures also
  passed. Receipt: `upload-improvements-native-39409187807.json`. Integrated live
  MEGA checks also passed on all three platforms: 54 recorded checks and 15
  independent hashes per platform, with verified cleanup. Receipts:
  `upload-improvements-live-{linux,windows,darwin}-39409214017.json`.
  Earlier local hashes/provenance are in
  `upload-improvements-local-464acac.json`.
- GitHub rejected final runs `39400711200` and `39401087755` before any steps in
  the inspected Linux jobs because of an account payment/spending-limit issue.
  See `upload-improvements-ci-blocked.json`. No failed-run live account objects
  were created by those jobs. The user supplied the temporary repository for
  subsequent runs; the successful native run above supersedes that native-check
  blocker without changing the original account or historical receipts.
- The full local upstream attempt returned failure: 171 package results passed,
  126 had no tests, eight packages could not start Docker/docker-compose fixtures,
  and `cmd/serve/s3` had a cache timing failure. The failing S3 test passed in an
  isolated follow-up (`TestPutObjectFailureCached`, 4.646s), without source changes.
  Do not describe the full suite as green. No Docker permissions or unrelated
  S3 code were changed.
- The fresh-process resume protocol gate passed all three cases with independent
  hashes and cleanup (`upload-resume-protocol-39409953855.json`). The encrypted
  codec, protected store and explicit local-file resume command are implemented.
  Final focused native checks and exact-binary live recovery passed on all three
  platforms, with 124 recorded checks, 17 independent hashes and verified cleanup.
  [UPLOAD_RESUME_VALIDATION.md](UPLOAD_RESUME_VALIDATION.md) records the final
  source, binaries and receipts. The previous test account was blocked; the user
  replaced its credentials. Its earlier failed-probe cleanup remains unverified.

The saved alpha references/artifacts are preserved, all M3 bundle checksums still
match their saved manifest, and no M3 code/settings/bundle replacement is included.
No release tag/promotion has been made; artifacts remain development builds.
Stage records below retain their results and limits at the time each was saved.

## Experimental durable resume implementation — 2026-10-20

The codec and native protected store are implemented and storage checks passed on
Linux, Windows and macOS at `ebbbc15` (`upload-improvements-native-39418887213.json`).
The explicit local-file resume command, source block verification, serialized
checkpoint writer and irreversible commit handling are implemented at `a032839`;
the pending-only hard/soft/cautious transfer-budget admission guard follows at
`39ee917`. Receipts `upload-resume-local-a032839.json` and
`upload-resume-local-39ee917.json` record local races, lint, native Linux CLI smoke
and TLS service fixtures using real encrypted checkpoints and fresh child processes.
The fixtures include abrupt process death, Unix signal cleanup, independent
file-key/ciphertext SHA-256 verification, committed-node idempotence and an
unusable finalization reply without replay.

The full native/upstream run `39436148540` passed at `a032839` on all three
platforms. Final focused native backend/dependency/store/accounting races, lint,
CLI builds and smoke passed in `39442759187` at `8de3a30`, including the final
non-retryable transient-commit-error regression. Native archive digests and
individual binary hashes are in `upload-resume-native-binaries-39442759187.json`.

All three exact final native binaries then passed integrated live CLI recovery in
`39445181034`: 124 recorded checks, 17 independent stock-client SHA-256 matches,
fresh authentication before resume and scoped cleanup. See
[UPLOAD_RESUME_VALIDATION.md](UPLOAD_RESUME_VALIDATION.md) and
`upload-resume-final-manifest.json` for exact provenance and remaining limits.

The prior account was blocked before protocol cases; cleanup-only receipt
`upload-resume-protocol-39432815707.json` records the failure. Its isolated folder
`rfork-protocol-8097f0bbab2147e28329abfe5e0215d6` remains unverified. Replacement
credentials passed read-only access and all new live gates; a different account's
listing cannot establish absence on the old account. No release tag or M3
binary/settings change is included.

## Hosted validation restart and resume probe preparation — 2026-10-20

The user pushed the same branch/history to `alphazoic/alpha-rfork` and supplied
the two dedicated-account repository secrets. `origin` remains unchanged; the
temporary remote is the branch's upstream/push destination. The local Actions
helper derives its API repository, branch and credential path from the selected
remote rather than assuming the original account.

Native checks passed on all three platforms in run `39409187807`; the duplicate
earlier dispatch was cancelled after workflow registration triggered its own run.
The live `improvements` workflow passed on Linux, Windows and macOS (`39409214017`):
54 recorded checks per platform, including 15 independent stock-client SHA-256
comparisons and verified scoped cleanup. The fresh-process protocol gate also
passed (`39409953855`), with three additional independent hashes and cleanup.
Results are kept separate from the original account's
pre-start billing failures.

Hash-verified native artifacts are retained under ignored
`build/validated-39409214017/`. These are development builds, not M3 replacements.

| Target | Live checks | Independent hashes | Cleanup | Native artifact SHA-256 |
| --- | --- | --- | --- | --- |
| Linux amd64 | 54 passed | 15 matched | verified | `4340cbeef83db8fdf9d419b301c40bd38da0f5664f9a546faa8cb57258d4251a` |
| Windows amd64 | 54 passed | 15 matched | verified | `76d60d5194a2c44a001d8a277e199e9fd8d6ec9fb409b71b55d9d39c607e9c36` |
| macOS amd64 | 54 passed | 15 matched | verified | `6f07065199c8b4aef8cb219f023ad63f7893357da32d7d4c25414085430611b5` |

Linux/macOS native binaries match the saved local cross-build hashes exactly.
The Windows native binary differs from the earlier cross-build, although their Go
build metadata (toolchain/options/dependencies) agrees. No cross-host reproducibility
claim is made for Windows; use the native artifact/checksum above, which passed the
live checks. The source commit and artifact digest are retained in each receipt.

A manual `resume-protocol` gate now exercises separate-process fresh authentication,
saved acknowledgements, accepted-data replay and a lost multi-chunk terminal reply.
It stores private test state only in owner-only runner temporary files, never in
artifacts. Receipts contain stages/counters/check results; scoped cleanup and stock
SHA-256 verification follow the existing protocol harness. No production resume API,
checkpoint format, M3 integration or release promotion is included.

Tests first failed because the new state helpers and Python resume selector did
not exist. After implementation, dependency race tests, seven Python runner
fixtures, workflow YAML parsing and parent/dependency lint passed locally. The live
gate subsequently passed: acknowledged-prefix restoration (no intentional pause),
accepted data absent from saved acknowledgements (15-second pause), and a deliberately
lost multi-chunk terminal response (one-second pause). Every case used separate
processes and fresh authentication, then passed an independent hash check. No
universal session lifetime or general expiry behavior is established. Production
encrypted checkpoints, process locking, source identity enforcement and uncertain-
commit recovery remain the next implementation stage; native storage/fault tests
must pass before advertising durable resume.

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
