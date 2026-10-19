# rfork upload improvement plan

Status: planning only. No upload implementation or M3 changes are included.

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

The historical creation plan is `PLAN.md`; completed results are in
`reports/VALIDATION.md`. This plan governs the next upload experiments.

## Findings and hypotheses

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

Extend the standalone benchmark harness with explicit candidate/control binaries,
paired execution and raw machine-readable reports. Build the saved baseline into
an immutable separate output. Verify instrumentation preserves hashes, behavior
and performance within observed noise before relying on its measurements.

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
settings and simultaneous files. Compare 10 ms and 0 at identical worker counts
with batching disabled. Add an intermediate interval only if measurements justify
it. Do not promote 0 solely because the theoretical ceiling disappears.

Deliverable: an independently measurable pacing change with a compatibility mode.

## 4. Batch native chunks into larger HTTP requests

First establish live MEGA acceptance of contiguous encrypted native chunks in one
POST, completion-handle behavior, replay behavior and any size/alignment limits.
Use tiny isolated test sessions and independent download verification. Record the
result as a protocol note before building the full worker scheduler.

Then introduce an opt-in request-size setting, tentatively
`--mega-upload-request-size`. `0` preserves one native chunk per request. Start
experimental payload targets at 2, 4 and 8 MiB; define them as maximum batch
payloads made of whole native chunks, with shorter batches at boundaries/EOF.
Validate range and units explicitly. Keep the current concurrency default of 8;
workers now process bounded request jobs rather than increasing their count.

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
an independent client. Benchmark batching with old pacing first, then the winning
pacing candidate, so their effects can be distinguished.

Deliverable: larger requests with preserved native crypto and measured benefit
at modest worker counts. Keep batching experimental if server semantics or gains
remain uncertain.

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

## 6. Performance comparisons and release gates

Run candidates sequentially against the dedicated test account, using unique
remote folders and verified cleanup. Use the existing repository secret names
`RFORK_MEGA_EMAIL` and `RFORK_MEGA_PASSWORD` only in manual trusted live workflows.
Publish sanitized results, hashes and settings; never private configs or keys.

- Primary workload: one exactly 1 GiB (1,073,741,824 byte) incompressible file.
  Label units explicitly. Report end-to-end completion and data-phase throughput.
- Use 8 workers for the first isolated experiments. Confirm promising settings
  at 5 and 12 workers. Serial/4-worker runs are diagnostic controls if needed;
  no planned performance trial exceeds 12 workers. Do not alter the public
  accepted concurrency range merely to impose the benchmark's smaller range.
- Alternate candidate/control order in paired runs on the same account, runner
  and route. Keep HTTPS, payload, worker count, retry policy and file concurrency
  fixed within each mechanism comparison. Record relevant runner/network context;
  GitHub-hosted network capacity is measured, not presumed to be gigabit.
- Screen each isolated change with three pairs. Confirm the selected combined
  candidate with at least five fresh pairs; report every failure, retry, timeout,
  range and paired difference as well as the median. Do not pick a winner from
  a single fast attempt. Extend inconclusive trials or report uncertainty.
- Avoid a full Cartesian sweep. Test pacing alone, batching alone, then their
  combination, retaining the saved binary as the control. Reserve enough account
  storage and transfer quota for verification and finish cleanup between runs.
- Secondary workloads: a multi-GiB file for sustained throughput, 16 x 64 MiB
  files for per-file overhead, two simultaneous files for aggregate memory and
  account isolation, and controlled interruption/retry cases. Keep these separate
  from the single-file ranking and record intentional file concurrency.
- Perform initial correctness/fault/race checks locally, controlled speed trials
  on GitHub Actions, then confirm chosen settings on the home route. A hosted
  runner result does not establish the home-network optimum.

Correctness gates: focused backend/dependency tests and race checks, relevant
operations/accounting tests, credential-free upstream suite, lint, CLI progress/
exit/cancellation compatibility, and independent-client SHA-256 verification of
each candidate configuration. Include chunk/batch boundaries, empty files,
replacement and uncertain-finalization checks. Verify cleanup after live faults.

Promotion requires a repeatable improvement larger than observed run variation,
or demonstrated recovery savings, with no integrity/finalization regressions and
documented memory/CPU costs. If speed is inconclusive, retain compatibility defaults
and report it; do not raise workers to manufacture a result. Keep raw reports.

Build versioned standalone Linux, Windows and macOS artifacts with provenance and
checksums after the code is committed. Run native correctness and live integrity
checks on each shipping platform; cross-compilation alone is insufficient. Update
the changelog, flag Help text, README, local-dependency notes and validation report.
Do not silently replace the existing alpha tag or artifacts.

Final deliverable: reviewed rfork commits, measured defaults, standalone validated
artifacts and a documented rollback to the saved release. M3 settings, adapters
and bundle replacement form a later, separately scoped task.
