# rfork creation and validation plan

This is the historical creation plan. The next upload development work is planned
in [UPLOAD_IMPROVEMENT_PLAN.md](UPLOAD_IMPROVEMENT_PLAN.md); its saved baseline and
scope take precedence over historical status statements below.

Status: implementation, Linux correctness/race checks and controlled performance
gates complete. Standalone alpha builds are complete; release packaging uses
bin/package-rfork.py. Windows/macOS native runtime validation and M3 integration
remain separate release gates. See reports/VALIDATION.md for results. M3's
bundled executables remain unchanged.

## Objective

Create an independent fork of rclone 1.75.2 named **rfork** that uploads different
native MEGA chunks of a single file concurrently, producing one ordinary MEGA
file and normal share link. Make it fast enough to be useful in M3's fallback
chain, while preserving file integrity and predictable failure handling.

The provided `../rclone-1.75.2/` is the source reference. Develop inside this
`rfork/` directory. The finished project must build and test after this folder
is moved away from M3.

## 1. Establish an independent, reproducible baseline

- Verify and record the supplied source against upstream v1.75.2. Copy it into
  this project without changing the reference directory. Record upstream tag,
  commit or archive hash, dependency versions and any supplied-source changes.
- Establish rfork's own Git history with an unmodified upstream baseline before
  implementation. Preserve upstream license files and attribution. Keep the
  upstream Go module/import paths initially to keep the fork diff small.
- Add a fork README, changelog, build instructions and release manifest. Name
  outputs `rfork` / `rfork.exe`; report both the rfork release and upstream base
  in version information. Retain compatible commands, MEGA configuration and
  JSON statistics used by M3.
- Pin a compatible Go toolchain and dependencies. The source declares Go 1.26.0;
  the currently inspected system Go is 1.24.4, so that toolchain must be supplied
  before compiling this version. Keep project-specific build outputs and caches
  separate from installed binaries.
- Build and smoke-test unmodified 1.75.2 first. Use explicit output paths rather
  than upstream's default `make` target, which also installs into GOPATH/bin.

Deliverable: a reproducible stock 1.75.2 baseline plus an independently movable
rfork source tree. M3's bundled rclone remains in place during development.

## 2. Specify the upload contract and write failing tests

Start in `backend/mega/mega.go`, especially `Object.Update`. Keep the first
implementation specific to the MEGA backend rather than changing rclone's
generic transfer engine or adding its full multipart interface immediately.

- Introduce a proposed `--mega-upload-concurrency` setting. `1` selects a serial
  control path; initially test 2, 4 and 8 workers. Validate the range and select
  a release default from measurements, rather than assuming more is better.
- Keep `--transfers` as the number of simultaneous files. Explain that potential
  chunk concurrency multiplies across concurrent files, and bound buffers and
  outstanding requests accordingly.
- Consume the provided input reader sequentially through a bounded producer.
  Send native chunk IDs and owned buffers to workers. Do not assume the source
  is an unwrapped local file, or concurrently read an arbitrary `io.Reader`.
- Preserve MEGA's native chunk offsets, encryption and authentication format.
  Assemble chunk authentication results in original chunk order. Finalize once
  only after every chunk has succeeded and all workers have stopped.
- On a source/chunk failure, stop producing work, cancel outstanding requests,
  collect worker failures and wait for worker shutdown before returning. Do not
  delete an existing destination before the replacement has committed.
- Preserve rclone bandwidth limiting, pacing and accounting. Keep read/buffered
  progress distinguishable from confirmed completion; a full progress bar must
  never substitute for successful finalization.

Tests must exercise the actual orchestration and finalization call path. Include
out-of-order completion, concurrency=1, tiny/empty files, native chunk boundaries,
short reads, source errors, worker errors, simultaneous failures, and bounded
buffer usage. Following the source's AGENTS.md, write regression tests before
implementing the fix they demonstrate.

Deliverable: a documented upload contract and tests that fail against the serial
implementation and unsafe error-handling variants.

## 3. Implement concurrency and audit the MEGA dependency

- Add the bounded producer and worker pool while leaving unrelated backends and
  download behavior alone. Keep one MEGA upload session per file.
- Audit the pinned `go-mega` implementation for shared state, chunk buffer
  mutation, authentication ordering, completion handles and retry behavior.
  Its existing parallel upload helper is a reference, not a replacement for
  rclone's input-reader and accounting path.
- Establish cancellation during network requests and retry waits. Account for
  the MEGA client cache being shared by account: cancelling one file must not
  shut down another transfer or alter a shared client's transport settings.
- Avoid retrying already-encrypted buffers as plaintext. Decide which layer owns
  each retry and keep attempts/backoff bounded. Verify context cancellation
  prevents new work and leaves no uploading workers after return.
- If the dependency lacks the necessary per-upload/context API, include a small,
  documented local dependency patch inside rfork with an explicit module
  replacement. Do not patch the global Go module cache or depend on M3 paths.
- Handle an unknown finalization outcome explicitly: a lost response can mean
  the remote file was already created. Do not claim rollback or blindly repeat
  finalization. Preserve the old object and return an actionable uncertain
  outcome when success cannot be established.
- Enable HTTPS by default for rfork's MEGA transfers, retaining
  `--mega-use-https=false` for diagnosis. Pass HTTPS explicitly in the performance
  comparisons so the unmodified baseline and the fork use the same transport.

Deliverable: a Linux rfork prototype with working serial/parallel controls and
bounded, tested failure behavior.

## 4. Verify correctness and failures before speed testing

- Run focused backend/dependency tests, then the relevant operations/accounting
  tests and the credential-free upstream unit suite. Run race detection on the
  changed concurrency paths; run lint/format checks as required by the source.
  Disable real cloud remotes for ordinary unit tests.
- Use controlled HTTP/API fixtures to inject transient and permanent failures,
  a failed final chunk, a failed commit, a lost commit response, cancellation
  during a request/backoff, and completions racing with cancellation. Check for
  stuck workers and false success. Test the real crypto/chunk path where possible,
  not just a fake worker that returns success.
- Perform isolated live smoke tests with dedicated temporary folders: upload,
  list, link, download, verify SHA-256, overwrite and delete. Confirm ordinary
  MEGA tools can download the result and that one source file creates one normal
  final file. Include files around chunk boundaries and representative large files.
- Audit cancellation/failure cases on the remote after workers/processes have
  stopped. Record uncertain outcomes rather than automatically replaying them.
  Remove only identified test objects and temporary credential files.

Gate: no known corruption, races, hangs, false completion, premature deletion of
the old object, or workers continuing after a reported stop.

## 5. Measure whether rfork is worth keeping

Use a runner kept inside rfork so the benchmark moves with the project. Reuse the
method and lessons from M3's HTTPS benchmark, including private credentials,
unique filenames, verified cleanup and TCP byte counts to identify bulk traffic.

- Establish fresh baselines on the same account and route: stock 1.75.2 over HTTPS,
  rfork concurrency=1 over HTTPS, and megatools at the user's configured settings.
  The earlier stock 1.73.3 results are historical context, not the control for a
  fork based on 1.75.2.
- Sweep concurrency 2, 4 and 8. Repeat promising settings in alternating order
  against the serial control. Begin with 512 MiB files and confirm the selected
  setting on larger representative files after throughput is known.
- Keep file contents, account, route, transport and top-level retry settings
  fixed. Record setup time, whole-file time, sustained throughput, errors,
  network bytes, CPU and peak memory. Bound each attempt using the baseline
  estimate and record incomplete runs separately.
- Download and verify files from each candidate configuration, with an
  independent MEGA client among the checks. Require genuine transferred bytes,
  not an existing-file skip or server-side copy.
- Test more than one simultaneous file to confirm the concurrency/memory bounds
  and account-cache isolation under normal rclone usage.

Performance gate: demonstrate a repeatable, material improvement, aiming for at
least 2x the same-version serial HTTPS control, and compare the resulting finish
time directly with megatools. That threshold alone does not prove suitability:
rfork must also be competitive with waiting 5–10 minutes and then using a faster
client, as described in the original problem. For a representative remaining
file size S, compare S / rfork_rate with recovery_delay + S / fast_client_rate.
Do not promote a fallback that still extends expected completion time severely.

If gains flatten or remain inadequate, inspect native request sizes, latency,
CPU, transport limits and pacing before adding more workers. Larger request
batching is a separate experiment because it must preserve native MEGA chunk
authentication. Do not combine that change with the first worker-pool benchmark.

Deliverable: raw measurements, hash results, resource/failure results and a clear
keep/tune/reject decision with a justified default concurrency.

## 6. Produce standalone releases and integrate later

- Create project-local build scripts and CI artifacts with pinned Go version,
  upstream/fork provenance, checksums and license files.
- Initial targets mirror the current bundles: Linux amd64, Windows amd64 and
  macOS amd64. Add ARM64 targets as separately tested release targets if needed.
- Run native smoke/integrity tests on each shipping OS. A successful cross-build
  is not evidence of runtime correctness on that OS. Label untested artifacts.
- Verify the CLI operations M3 uses: obscure, mkdir, copy/copyto, about, link,
  listing, JSON progress, exit status and cancellation.
- After the correctness/performance gates pass, plan a separate M3 integration:
  bundle the released binaries, update executable resolution and settings, pass
  explicit concurrency/HTTPS options, verify progress and Stop/Skip behavior,
  and retain a straightforward rollback to the current bundle. Avoid counting
  rfork and its rclone base as independent fallback implementations.

Deliverable: versioned standalone rfork binaries and a distinct, reviewable M3
integration change. Copying binaries into M3 is the final integration step.

## Scope of the first implementation

The first build targets parallel uploads to MEGA, compatibility with M3's CLI
usage, data integrity and bounded cancellation. It does not promise upload
resumption after a process restart, transfer-state sharing with MEGAcmd or
megatools, or a complete redesign of rclone's generic multipart interfaces.

The first meaningful milestone is a Linux prototype that passes fault/race/hash
checks and outperforms stock **1.75.2** in a controlled single-file comparison.
Cross-platform release work follows demonstrated correctness and speed gains.
