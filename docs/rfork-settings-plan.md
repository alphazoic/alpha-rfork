# Plan: expose rfork configuration in M3

Status: complete, 2026-10-21. Settings/adapter/recovery regressions, broader
upload/VPN and Electron checks, and native packaged/live validation passed on
Linux, Windows and Intel macOS. See [results and receipts](rfork-settings-validation.md).
The stages below preserve the accepted implementation plan.

## Goal and inspected starting point

Expose the useful upload, transport and recovery controls already implemented in
rfork, so experiments can be performed through M3. Do not run worker-count sweeps
or select new performance defaults during integration.

M3 currently hard-codes eight workers, HTTPS, a 20-second connection timeout,
60-second I/O idle timeout and 90-second progress watchdog in `src/rfork-upload.js`.
It uses ordinary `copyto`, one file at a time, with both generic retry counts set
to one. Settings has dedicated megatools/MEGAcmd controls but no rfork card.
`src/upload-engine.js` captures configuration at the start of an upload run.

The validated new binaries implement the additional controls and a separate
`backend upload-resume` command. Their manifest and exact-binary native/live
receipts are in `rfork/reports/upload-resume-final-manifest.json` and
`rfork/reports/UPLOAD_RESUME_VALIDATION.md`. M3 still bundles the earlier alpha.
No further rfork binary changes are required for the controls planned below.

## Settings and behavior

Add an **rfork Uploads** card alongside the existing uploader cards. Keep the
persisted provider ID `rclone` and existing tool orders. New saved configuration
lives in a versioned `rforkUpload` object rather than reusing megatools' keys.

Show workers, HTTPS and request bundling in the main card; place less frequently
used controls in expandable Advanced and Restart/resume sections. Every numeric
control accepts direct numeric entry, with explicit units, rather than restricting
users to a few presets. Sliders/presets may be conveniences. Include rfork-only
Reset defaults and an effective-settings summary; saving applies to the next
upload run, and an active run keeps its captured settings.

### Upload and transport controls

| User setting | Interface / meaning | Initial M3 value and validation |
| --- | --- | --- |
| Workers per file | `--mega-upload-concurrency` | 8; integers 1–20. Keep the user's usual 5–12 range visible in help. The binary's compatibility ceiling is 32; M3 does not need to use it. |
| HTTPS | `--mega-use-https=true/false` | On. HTTP remains available for ordinary uploads. Restart/resume requires HTTPS. |
| Bundle upload requests (boost) | `--mega-upload-request-size` | Off, producing `0`. Remember a separate bundle-size value while disabled. |
| Maximum bundled request size | Same flag, with explicit `Mi` or `B` units | Remember 4 MiB initially, without calling it optimal. Accept any binary-valid size from 1–64 MiB, including custom values; actual requests preserve native chunk boundaries and may be shorter. |
| Data-request pacing | `--mega-upload-pacing` | 10 ms; nonnegative duration, zero disables it. Includes retried data requests; metadata/API backoff remains intact. |
| Extra data-request retries | `--mega-upload-retries` | Inherit (`-1`); also allow zero or an explicit nonnegative integer. Separate this from whole-file retry. With M3's existing low-level retry count of one, inheritance preserves current behavior. |
| Replay incomplete response bodies | `--mega-upload-retry-body-errors` | Off; explicit opt-in. Reuses original ciphertext within the data retry budget; never authorizes replaying finalization. |
| Collect upload diagnostics | `--mega-upload-diagnostics` | Off. Show sanitized `megaUpload` / `megaResume` numeric counters in transfer details; diagnostics do not establish completion. |
| Upload bandwidth cap | `--bwlimit` | Unlimited; numeric rate with KiB/s or MiB/s selector. Applies to this uploader process, not every M3 upload tool or the whole queue. Counts source payload, not exact TCP/TLS traffic including retries. |
| Source read buffer | `--buffer-size` | Ordinary mode only, default 16 MiB; allow zero. This is rclone's per-file read-ahead buffer, not a worker socket buffer. Disable with an explanation in resume mode because that command uses its own fixed reader. |
| Maximum simultaneous backend requests | `--max-connections` | 0 / unlimited; positive integers cap backend request admission. Distinct from workers. Display the effective restriction without silently changing the worker count. |
| HTTP request-rate cap and burst | `--tpslimit`, `--tpslimit-burst` | Disabled (0 requests/s), burst 1. Allow nonnegative rate and positive integer burst; affects HTTP transport requests, including metadata, separately from data pacing. |
| Connection timeout | `--contimeout` | 20 seconds, preserving M3's current behavior. Positive duration. |
| Network I/O idle timeout | `--timeout` | 60 seconds. Positive duration; not a whole-upload time limit. |
| No-progress watchdog | M3 adapter timer | 90 seconds; positive duration or explicitly disabled. Make it aware of configured pacing/rate limits and of hashing/verification/commit stages rather than treating every interval without uploaded bytes as a stall. |
| Maximum attempt duration | `--max-duration` | Unlimited (0); nonnegative duration. Resume includes preflight verification. A configured limit stops the attempt; it does not prove remote absence. |
| Maximum attempt payload and cutoff mode | `--max-transfer`, `--cutoff-mode` | Unlimited; optional positive byte limit and hard/soft/cautious choice. Explain per-process semantics, native chunk/accounting granularity, and that resumed attempts count only pending bytes. A user-requested stop must not silently trigger another tool to bypass the limit. |
| Allow HTTP/2 | `--disable-http2` (inverse) | On; advanced transport experiment. Actual protocol still depends on the endpoint. |
| Reuse HTTP connections | `--disable-http-keep-alives` (inverse) | On; advanced transport experiment. |
| Progress update interval | `--stats` | 1 second; positive interval. JSON format and stats log level remain adapter-owned. |

A boost switch maps to request grouping; it does not alter MEGA's native crypto
chunks. Display a request-buffer estimate using `(workers + 1) × request limit`
(or up to 1 MiB per request with native requests), plus up to 1 MiB encryption
scratch per worker. Label this a component estimate: source buffers, native MACs,
fingerprints and runtime/transport overhead are additional. Do not claim that
`--max-buffer-memory` caps rfork's payload buffers.

Keep generic `--retries 1 --low-level-retries 1`, `--transfers 1`, destination
paths, `--ignore-times` in ordinary mode and structured output under adapter
control. The dedicated data retry setting supplies the useful retry adjustment
without reopening full-file retries. Do not expose deletion policy, raw request
dumps, certificate-verification disabling, arbitrary extra flags or internal
account/session keys as performance settings. Existing M3 proxy/VPN settings stay
the authority for routing. No unrelated browsing, account or download tuning is
implied by an upload-only setting.

### Restart/resume controls

| User setting | Initial value / contract |
| --- | --- |
| Keep restart checkpoints | Off initially, preserving ordinary `copyto`; enabling selects the explicit local-file backend command. |
| Checkpoint flush interval | 1 second; nonnegative duration including zero for immediate coalesced flushes. Explain disk-write frequency versus potentially repeated data after a crash. |
| Checkpoint storage location | Display the M3-managed private local path, with a validated Change location action while idle. Never silently place checkpoints in a synced/network data folder. Windows requires a fixed local NTFS volume; Unix needs private ownership and modes. Retained transfers keep their original paths; never auto-move or delete held state when changing the preference. |

If HTTPS is disabled, explain the conflict and require HTTPS before enabling
resume; do not silently override saved settings. Turning resume off affects new
transfers only and never discards a retained checkpoint or converts it to a fresh
ordinary upload. Resuming an existing transfer always reuses its saved account,
parent, name, source and checkpoint. Its performance settings may be changed for
the next attempt; its identity may not.

Checkpoints contain private encrypted state and are owned by rfork. M3 stores only
its transfer mapping and lifecycle metadata, not copies or interpretations of the
envelope. Completed uploads retain a tombstone until M3 has durably recorded the
completion; interrupted or uncertain transfers retain their entire directory.
No automatic cleanup of held state. Provide Resume and Inspect destination
recovery actions; an explicit discard/restart must first resolve remote outcome
and preserve the existing duplicate-prevention behavior.

## Implementation stages

### 1. Bring the validated binaries into M3

- Copy the exact Linux, Windows and macOS amd64 binaries from the final verified
  artifacts, preserving executable permissions. Keep the separate rfork source
  repository and build caches outside packaged resources.
- Update bundle version, hashes, byte sizes, source and receipt references, and
  include matching sanitized native/live validation records and licenses.
- Update `src/rfork-bundle.js` and its checks to recognize the new receipt schema
  consistently across platforms. In particular, its current Linux branch expects
  an older large-file receipt shape. Preserve strict hash/evidence validation.
- Preserve the existing alpha manifest/artifacts as the explicit rollback target.
  Record the development version honestly; a release tag is not implied.

Gate: every shipped executable matches its validated target/hash, and the new
flags/backend command are available in the native packaged executable.

### 2. Add a typed configuration model and Settings UI

- Add `src/rfork-settings.js` with versioned defaults, strict main-process
  normalization/validation, cross-setting rules and explicit-unit CLI builders.
  Reject malformed values, partial numeric strings, nonfinite numbers and invalid
  combinations with field-specific errors. Preserve meaningful zero/false/-1
  values; do not use truthiness defaults.
- Validate the `rforkUpload` draft before `main.js` passes it to the existing
  configuration save service. Preserve its VPN validation/transaction behavior,
  unrelated settings and existing account/tool order IDs.
- Add controls in `index.html` and save/load bindings in `renderer/settings.js`.
  Missing rfork settings load compatibility defaults. Renderer hints and backend
  validation agree; values round-trip and reset without changing other cards.
- Capture a normalized immutable settings snapshot at upload-run start, consistent
  with current engine behavior. Do not label these settings as changing an already
  running process.

Gate: save, reopen, reset, old-config migration and invalid IPC drafts behave
correctly; zeros and explicit disabled toggles survive persistence.

### 3. Wire ordinary uploads, diagnostics and timeout handling

- Pass the normalized settings from `src/upload-engine.js` to
  `src/rfork-upload.js`, building argv as an array with no shell interpolation.
  Include explicit booleans/units and keep existing retry/commit protections.
- Extend bounded JSON parsing in `src/rfork-output.js` for allowlisted numeric
  diagnostic fields. Summarize source payload, attempted payload, acknowledged
  data and commit status separately. Never turn retry bytes or 100% read progress
  into proof of successful publication.
- Integrate rate-aware and phase-aware watchdog behavior. Long local verification
  has no network progress; do not kill it after the old 90-second threshold.
  M3 may show indeterminate preparation/finalization where the binary provides
  no intermediate phase event. Do not invent checkpoint progress by reading its
  encrypted contents. Configured duration/I/O limits remain distinct.
- Keep metadata helpers such as mkdir/link on their established path; upload-only
  flags do not accidentally change browsing, quota refresh or account creation.
- Show effective settings, version and safe counters for the attempt so later
  experiments can be reproduced. Do not log credentials or checkpoint contents.

Gate: each setting demonstrably reaches the correct option and changes the
relevant behavior, with existing cancellation, quota, fallback and share-link
protections intact.

### 4. Integrate explicit checkpoint recovery

- Add a resume path using `backend upload-resume :mega:existing/directory
  /absolute/source --json -o name=leaf -o checkpoint=/absolute/private/transfer`
  and `-o checkpoint-interval=...`, plus applicable shared upload settings.
  Ordinary copy flags are not blindly copied to the backend command.
- Ensure the destination directory exists and the source is a regular local
  file. rfork refuses an existing destination name in this mode; preserve that
  distinction from ordinary replacement behavior.
- Migrate `src/upload-journal.js` to track resume-capable entries and stable
  opaque transfer directories. Continue to read existing schema-1 holds without
  claiming they have resumable state. Add a recovery route through
  `src/upload-recovery-review.js`, `main.js`, `preload.js` and upload UI as needed.
  A global legacy `assertClear()` must not prevent the selected safe resume while
  still preventing unrelated retries to held destinations.
- Pin the original account, destination and source across queue reload, account
  rotation, VPN recovery, Stop, Skip and application restart. The split-file
  lifecycle must retain a resumable source until its outcome is resolved; never
  delete/recreate temporary split files behind retained state. Resume-enabled
  attempts cannot silently fall back to another tool/account or new checkpoint.
- Parse bounded stdout result JSON separately from stderr logs. Success requires
  exit 0 plus `committed` or `already-committed`; share-link failure afterward
  must not upload again. Preserve the confirmed identity for reconciliation.
- Show current-attempt pending-byte stats separately from restored bytes.
  Authenticated restored counters are reported in the command's final result /
  optional final diagnostics; do not assume they stream at startup. Combine only
  validated totals, otherwise show current-attempt progress with preparation or
  recovery status. A future early restored-progress event would be a separate
  optional rfork enhancement, not a prerequisite for this integration.
- Preserve state after every failed/cancelled resume. Exit 6 alone does not
  identify the checkpoint phase; expired session, binding refusal and uncertain
  finalization require inspection. Stop waits for process closure before releasing
  locks/network ownership. Turning resume off cannot bypass any retained hold.

Gate: a real M3-controlled upload survives interruption and restart, resumes the
same session, produces one independently verified file, and cannot duplicate an
uncertain/committed upload through fallback or recovery review.

### 5. Validate and package

- Focused settings/argv tests: defaults, all fields and boolean inversions, units,
  zero/false/inherit values, range/cross-field failures, persistence and run
  snapshots. Use boundaries and representative combinations, not an exhaustive
  performance matrix.
- Adapter process fixtures: JSON split lines, malformed/oversized diagnostics,
  stdout result handling, pending/restored accounting, slow/paced uploads, disabled
  watchdog, verification, timeout, Stop/Skip, commit uncertainty, share-link
  failures, identity/source conflicts, legacy holds, and resume-mode changes with
  retained state. Check real state transitions rather than only matching flags.
- Electron UI fixtures: settings visibility, custom values, save/reload/reset,
  dependency hints, transport/resume conflict, recovery actions and tool orders.
- Run bundle and adapter checks plus affected upload/VPN/recovery regressions.
- On native Linux, Windows and macOS, verify packaged binary resolution and run
  a small fixed-setting live M3 upload, interruption/restart, independent stock
  download/hash, completed-state reuse and scoped cleanup. Use modest workers;
  correctness cases may use different values to establish configurability.
- Record tested M3 source, binary hashes, effective settings and platform receipts.
  Exclude secrets, private configurations and checkpoint directories from logs,
  artifacts and package contents. Confirm explicit rollback remains available.

Complete when the controls persist and affect the actual bundled process,
resumable transfers retain their identity and safety through M3 recovery, and
native packaged validation passes. A 1 GiB speed comparison or parameter sweep
comes afterward through M3, using these configurable controls.
