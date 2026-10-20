# rfork upload improvement plan

Status: diagnostics, chunk-retry improvements, separate pacing and request grouping
are implemented and pass focused
Linux race tests and lint; see [reports/UPLOAD_IMPROVEMENTS.md](reports/UPLOAD_IMPROVEMENTS.md).
The live batching/offset/terminal-replay protocol gate passed, with independent
hash checks and verified cleanup. Response-body replay remains opt-in. Full native
checks passed on Linux, Windows and macOS in the temporary repository (receipt:
`reports/upload-improvements-native-39409187807.json`). Integrated live CLI checks
also passed on all three platforms (15 independent hashes each and verified cleanup,
run `39409214017`). The fresh-process resume protocol gate passed as well
(`39409953855`). Encrypted checkpoints and native protected storage are now
implemented; the experimental explicit local-file command and process recovery
fixtures are committed at `a032839`. Local races/lint/CLI smoke passed. Full native
command checks passed in `39436148540` at that source. The subsequent
pending-transfer-budget guard is committed at `39ee917`, with final focused
native tests/builds passed in `39437206355`; its local receipt is
`reports/upload-resume-local-39ee917.json`. Integrated live command recovery and
release promotion remain pending. The previous MEGA account was blocked through
stock rclone; replacement credentials passed read-only stock access in `39438939305`.
Prior-account failed-probe cleanup remains unverified. M3 changes are outside
this work.

The worker pool now supports opt-in bounded request jobs while native request
behavior remains the default; see [reports/UPLOAD_PROTOCOL.md](reports/UPLOAD_PROTOCOL.md).

The original GitHub account blocked the final native/live runs before any steps
executed because of a billing/spending-limit restriction. The user supplied a
temporary repository, `alphazoic/alpha-rfork`, and added the dedicated test-account
secrets there. Hosted validation is being resumed on the same source history;
`origin` remains the original repository. The passed two-process resume gate,
remaining limits and implemented state-machine contract are in
[RESUME_DESIGN.md](RESUME_DESIGN.md).

Local final validation is recorded in
[reports/upload-improvements-local-464acac.json](reports/upload-improvements-local-464acac.json):
all three targets build, Linux CLI smoke and targeted races/lint pass, and M3
bundle hashes are unchanged. The attempted full upstream suite is not green due
to Docker fixture access and an S3 cache timing failure that passed in isolation;
see the validation report for exact limits. Resume local checks are recorded in
`reports/upload-resume-local-a032839.json`; integrated live validation and release
promotion remain unfinished.

## Objective and saved baseline

Improve single-file MEGA upload completion time and recovery at modest concurrency,
while preserving ordinary MEGA files, independent-client compatibility, bounded
memory, cancellation and safe finalization. Work stays in the standalone rfork
repository until validation justifies a separate M3 integration.

The existing repository was clean before this plan was written. Its saved baseline
is commit `2500ccc2fe0e117a95df1860355c1483408291a7`, including the native-platform
validation records. The existing release tag
`v1.75.2-rfork.0.1.0-alpha.1` points to build-source commit
`5b2efa9af79e259a6313241d0cc61acff8f87e47`; subsequent baseline commits add CI and
validation records. Keep those references and existing release artifacts intact.
New work begins on `codex/rfork-upload-plan`, with separate commits per stage.

Tuning scope: expose worker count, request/batch size and upload pacing as CLI
configuration so performance experimentation can happen through M3 later. Do not
run worker-count sweeps or select optimal configurable values in this project.
Exercise different values in correctness tests to establish that the controls
work safely. Performance experiments here are warranted only to decide an
internal implementation choice that cannot be left configurable, or as a small
fixed-configuration regression check; they are not a search for optimal settings.

The historical creation plan is `PLAN.md`; completed results are in
`reports/VALIDATION.md`. This plan governs the next upload experiments.

## Findings in the saved baseline and hypotheses

- `deps/go-mega/mega.go: UploadChunkContext` encrypts and sends one native chunk
  per HTTP POST. Most chunks are 1 MiB. Grouping complete native chunks into a
  larger request may reduce overhead and improve throughput without more workers.
  Server acceptance, completion-handle behavior and retry semantics must be
  established before treating batching as a supported feature.
- `backend/mega/mega.go: pacedUpload` uses the shared backend pacer for every
  chunk. Its minimum interval is 10 ms, implying approximately 100 request starts
  per second, or 100 MiB/s with 1 MiB chunks before other overhead. This is a
  code-derived constraint, not a diagnosis of the slower benchmark attempts.
- Chunk response bodies are read outside the existing transport retry loop.
  Recoverable response failures can abort an upload despite available retry
  budget. Whether a particular request can be replayed safely must be tested.
- Upload state exists only in memory. Durable resume could save substantial
  retransmission, but depends on server session lifetime and replay semantics.
- More workers are not presumed faster. Encryption or socket-buffer changes are
  secondary candidates only if measurements identify them as limiting factors.

## Invariants for every stage

- Preserve native chunk boundaries, offsets, AES-CTR positioning, individual MACs
  and file-order MAC folding. HTTP request grouping must not redefine the crypto
  format. A source file still creates one normal MEGA file.
- Read the source sequentially through rclone accounting and bandwidth limiting.
  Keep workers, request buffers, retry memory and diagnostic storage bounded.
  Cancellation stops requests/backoff, joins workers and releases buffers.
- Distinguish source bytes read, ciphertext transmitted (including retries),
  chunk payload acknowledged and file commit confirmed. None alone substitutes
  for successful finalization. Existing CLI progress remains compatible.
- Finalize once after all chunks succeed. Never blindly replay an uncertain
  final commit or remove an existing destination before its replacement commits.
- Preserve current flags and behavior by default during development. New
  experiments are opt-in; retain a path reproducing the saved uploader.
- HTTPS remains enabled. Keep API protection separate from data-transfer tuning;
  do not remove metadata/API backoff to accelerate chunk requests.
- Restrict implementation changes to the MEGA backend, its pinned local
  dependency, and rfork's tests/tools/docs where possible. Leave M3 settings and
  bundled binaries untouched throughout this plan.

## 1. Add measurements and establish a fresh control

Implement optional structured upload diagnostics before changing scheduling:

- Whole-file and upload-session setup time, first data request, data completion
  and final-commit time; record precise timing boundaries.
- Per-stage totals/distributions for source reads, encryption/MAC work, pacer
  waits, request duration, response reading and retry backoff. Overlapping worker
  durations are not additive wall-clock phases; report them accordingly.
- Active requests, payload sizes, acknowledged bytes, retry counts/categories,
  retransmitted payload bytes, process CPU and peak RSS. Distinguish application
  byte counts from sampled network-interface traffic.
- Emit bounded aggregates by default when diagnostics are enabled, with bounded
  detailed samples if needed. Exclude credentials, upload URLs/tokens, encryption
  keys, share links and private filenames. Benchmark records include binary
  SHA-256, source commit, effective settings, runner, route, file bytes and seed.

Keep diagnostic output usable by a later M3 benchmark without requiring a new
standalone tuning campaign. If a performance check is needed for an internal
implementation decision, use explicit candidate/control binaries, fixed identical
settings and raw machine-readable reports. Keep the saved baseline output separate.
Verify instrumentation preserves hashes and behavior, with bounded overhead.

Deliverable: a reproducible control and measurements that locate waiting instead
of inferring bottlenecks from total transfer time alone.

## 2. Strengthen chunk recovery independently

Write failing regression fixtures first, then move response reading and protocol
validation into an explicit bounded chunk-attempt policy:

- Classify transient transport failures, incomplete response bodies, retryable
  HTTP statuses and MEGA errors separately from permanent errors. Respect server
  retry guidance where applicable; use cancellable bounded backoff with jitter.
- Encrypt once and reuse identical owned ciphertext for permitted retries. Do
  not re-encrypt ciphertext or count retransmission as new source progress.
- Establish which offsets and completion responses can be replayed safely,
  especially the request completing the upload. An ambiguous terminal response
  must not trigger an unproven replay policy.
- Give the chunk layer ownership of chunk retries, document interaction with
  rclone low-level and whole-file retries, and avoid multiplying retry budgets.
- Preserve cancellation, worker joining, old-destination safety and the
  non-retryable uncertain-finalization result. Reconcile an uncertain commit only
  with sufficient identity evidence; a matching filename alone is insufficient.

Fixtures cover failures before/after bytes are sent, truncated successful bodies,
provider errors, exhausted budgets, duplicate accepted offsets, cancellation in
backoff, opaque completion handles and a lost final-commit response. Live tests
must confirm relevant server behavior rather than assuming the fixture proves it.

Deliverable: fewer avoidable restarts with unchanged successful-file semantics.

## 3. Separate data pacing from metadata/API pacing

Add a MEGA-specific configurable interval for upload request starts, tentatively
`--mega-upload-pacing`. Retain `10ms` as the compatibility default; `0` allows
unpaced data-request starts, still bounded by worker count and global user limits.
Define and test interval validation and the scope across concurrent files sharing
the same backend. Settings must not leak through account-level client caching.

Keep metadata/finalization pacing, provider-error backoff, bandwidth limits and
explicit global user request limits effective. Apply the data interval per HTTP
upload attempt, including retry attempts, with cancellable waits. The old wrapper
spaces chunk calls while dependency retries happen internally; account for that
distinction in diagnostics and document the new semantics.

Test start spacing with controlled synchronization, cancellation, independent
settings and simultaneous files. Accept valid nonnegative intervals rather than
a fixed menu of tuned values, subject to documented implementation limits. Test
zero, the compatibility default and intermediate values functionally. Preserve
the compatibility default; performance tuning of the interval belongs in M3.

Deliverable: an independently measurable pacing change with a compatibility mode.

## 4. Batch native chunks into larger HTTP requests

First establish live MEGA acceptance of contiguous encrypted native chunks in one
POST, completion-handle behavior, replay behavior and any size/alignment limits.
Use tiny isolated test sessions and independent download verification. Record the
result as a protocol note before building the full worker scheduler.

Then introduce an opt-in request-size setting, tentatively
`--mega-upload-request-size`. `0` preserves one native chunk per request. Start
correctness cases at 2, 4 and 8 MiB; define configured sizes as maximum batch
payloads made of whole native chunks, with shorter batches at boundaries/EOF.
These are test examples, not a performance-derived menu or a hard-coded optimum.
Validate range and units against verified protocol and resource limits. Keep the
current concurrency default of 8; workers process bounded request jobs rather
than increasing their count. Expose batching enablement and size for later M3 use.

Separate native-chunk preparation/MAC bookkeeping from request submission. Batch
only contiguous native chunks, retain every native MAC in file order, and use
the first chunk's offset for the request. Retain immutable ciphertext while a
batch is eligible for retry. Mark all constituent chunks acknowledged only after
the request succeeds; preserve correct handling of the upload completion handle.

Use a bounded producer and owned buffers. Document the actual memory bound before
promotion: at most workers+1 payload buffers at the configured request size, plus
separately accounted crypto scratch, per-chunk state, source read-ahead and HTTP/
runtime overhead. Avoid retaining duplicate full plaintext/ciphertext batches;
use buffer reuse only with explicit ownership and cancellation tests. Multiple
files multiply these costs; generic read-buffer limits do not cap these buffers.

Tests exercise early varying-size native chunks, AES boundaries, short final
chunks, zero/tiny files, out-of-order batches, retransmission, cancellation, source
errors, final-handle arrival and memory bounds. Verify MAC/key compatibility with
an independent client. Test batching and pacing both separately and together for
correct operation. Leave their performance settings configurable for M3 tuning.

Deliverable: configurable larger requests with preserved native crypto and bounded
resources. Keep batching experimental if server semantics remain uncertain; do
not claim a measured speed benefit without supporting results.

## 5. Investigate durable resume as a separate feature

Do not make restart resume a prerequisite for the batching/pacing release. First
test session survival across process loss, delays and fresh authentication; offset
replay, accepted-data persistence and interrupted terminal/commit responses.
Determine what the server can confirm versus what a local checkpoint only claims.

If those results support safe resume, specify and implement:

- An opt-in local checkpoint containing required session, crypto, native MAC and
  acknowledged-offset state, with schema versioning, atomic writes and exclusive
  ownership. Treat it as sensitive capability/key material: protect it using
  appropriate OS permissions/secret storage, never log it or commit it.
- Source and destination identity checks strong enough to reject changed files
  or conflicting replacements. Do not trust size/mtime alone. Initially limit
  restart resume to an explicit seekable local-file path; preserve existing
  arbitrary-reader uploads and avoid unsafe generic operations changes.
- Recovery from a crash between server acceptance and checkpoint persistence,
  expired/invalid sessions, stale state and uncertain commit outcomes. Never
  infer commit success from a name/size match or create duplicates automatically.
- Clear CLI status for resumed, expired, rejected and uncertain sessions, plus
  checkpoint lifecycle/cleanup rules after confirmed success or explicit discard.

Gate: either demonstrate safe restart recovery with independent integrity checks
and quantify retransmission saved, or record why it is unsupported and ship the
other improvements without promising resume. Stop and reassess any requirement
for broader rclone core interfaces before expanding implementation scope.

## 6. Correctness, limited performance checks and release gates

Run live validation sequentially against the dedicated test account, using unique
remote folders and verified cleanup. Use the existing repository secret names
`RFORK_MEGA_EMAIL` and `RFORK_MEGA_PASSWORD` only in manual trusted live workflows.
Publish sanitized results, hashes and settings; never private configs or keys.

- No performance sweep of worker counts, request sizes or pacing intervals, no
  required home-versus-hosted tuning, and no selection of optimal defaults. Keep
  compatibility defaults while exposing the new controls through the CLI.
- Exercise serial and parallel operation in fixtures/race tests to catch ordering,
  buffer ownership, cancellation and deadlock bugs. These are correctness tests,
  not timed rankings. Use a fixed modest worker count for ordinary live checks.
- Verify the protocol-sensitive batching/retry/resume behaviors against the live
  server with independent hash checks. Use boundary-sized and representative
  large files as correctness requires, rather than a speed-test matrix.
- Test simultaneous files for aggregate memory and account isolation, and inject
  interruptions/retries for recovery behavior. Confirm configuration actually
  changes request sizes and pacing while preserving all upload invariants.
- If an internal hard-coded algorithm or limit needs a performance decision,
  first record why it cannot reasonably be configurable. Compare only that choice
  at fixed worker count and other settings. Bundle-size/per-worker interactions
  may be measured for such a decision, but configurable request size itself does
  not require choosing an optimum here. A small fixed-settings baseline comparison
  may also check for a major implementation regression without tuning settings.
- Any timed comparison uses the same payload, account and route, alternating
  candidate/control order with enough repeats to distinguish a result from noise.
  Record exact bytes, effective settings, failures and timing boundaries. Use
  exactly 1 GiB (1,073,741,824 bytes) if repeating the original large-file workload;
  label units explicitly. Do not claim hosted network capacity without measuring it.

Correctness gates: focused backend/dependency tests and race checks, relevant
operations/accounting tests, credential-free upstream suite, lint, CLI progress/
exit/cancellation compatibility, and independent-client SHA-256 verification of
each candidate configuration. Include chunk/batch boundaries, empty files,
replacement and uncertain-finalization checks. Verify cleanup after live faults.

Promotion requires working configurable controls, no integrity/finalization
regressions, safe recovery behavior and documented resource bounds. Finding the
fastest settings is not a release gate. Keep raw validation reports, describe any
unmeasured speed claims as hypotheses, and leave performance tuning to later M3
experimentation. Preserve compatibility defaults unless the user requests otherwise.

Build versioned standalone Linux, Windows and macOS artifacts with provenance and
checksums after the code is committed. Run native correctness and live integrity
checks on each shipping platform; cross-compilation alone is insufficient. Update
the changelog, flag Help text, README, local-dependency notes and validation report.
Do not silently replace the existing alpha tag or artifacts.

Final deliverable: reviewed rfork commits, documented configurable controls,
standalone validated artifacts and a rollback to the saved release. M3 settings,
adapters, bundle replacement and performance tuning form a later task.
