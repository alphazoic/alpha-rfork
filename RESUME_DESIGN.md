# Restart-resume investigation and implementation contract

Status: the account-bound encrypted codec, protected atomic storage and explicit
local-file `upload-resume` command are implemented on the development branch.
The store passed native Linux, Windows and macOS checks at `ebbbc15`
(`reports/upload-improvements-native-39418887213.json`). The command, source-block
verification, coalesced writer and commit-state integration pass local fixtures,
races and process recovery tests; their final native checks are pending.
Integrated live command recovery remains unverified. The MEGA testing account
currently reports blocked even through pristine stock rclone, preventing live
checks and verification of the earlier failed probe's cleanup. Resume is
experimental and is not promoted as release-ready. M3 remains unchanged.

## Protocol evidence and remaining limits

The saved live receipt `reports/upload-protocol-39397241665.json` establishes
multi-chunk POSTs, replay of an accepted nonterminal offset, and recovery of a
usable terminal handle from identical ciphertext. Both files passed independent
stock-client SHA-256 checks. These requests ran in one process/session.

The reference SDK persists upload URLs, crypto/MAC state and upload tokens in its
transfer cache (`src/transfer.cpp`); its mechanism is useful evidence, not proof
of this fork's process-restart behavior or any guaranteed server session lifetime.

The fresh-process gate passed in run `39409953855`, source `a39c3b5`; receipt:
`reports/upload-resume-protocol-39409953855.json`. Process A saves private state
and exits; process B authenticates freshly and finishes the same URL/key session.
All three 9 MiB+31-byte files passed independent stock-client SHA-256 checks and
scoped cleanup was verified. Batches target 4 MiB and retain native crypto boundaries.
Accepted-data replay and recovery of a deliberately lost multi-chunk terminal reply
both worked after process exit. This establishes the tested protocol behavior.

The manual workflow now has a `resume-protocol` choice implementing the first
three process-restart checks. It uses separate test-executable processes with fresh
logins, an original-key/native-MAC snapshot, exact account/parent binding and an
independent stock-rclone SHA-256 download. Cases are an acknowledged prefix (no
intentional delay), accepted bytes whose acknowledgement is absent from saved
state (15-second delay), and a multi-chunk terminal response deliberately lost
after the server replies (one-second delay). Scoped remote cleanup runs even on
failure. This is a correctness probe, not a performance or worker-count sweep.

The current probe uses the encrypted production codec in private Linux runner
temporary files; it saves commit intent before finalization and the confirmed node
afterward. These files are never included in artifacts. The saved receipt above
used the earlier test-only snapshot. The encrypted-codec run also passed all three
cases with independent hashes and cleanup at `8947a62`: receipt
`reports/upload-resume-protocol-39417109063.json`. Focused native races, lint,
builds and CLI smoke passed on all three platforms in run `39417104289`.
Offline tests validate authenticated rejection, binding, restoration and phase
guards. The probe cannot establish general session expiry, native
Windows ACL/locking behavior, crash-safe checkpoint durability or uncertain-commit
recovery. Those remain separate implementation/release requirements.

## Source and destination contract

- Initially support an explicit seekable regular local file. Keep arbitrary
  `io.Reader` uploads and normal `copyto` behavior unchanged. Do not guess a local
  path through accounting/reader wrappers. Use an explicit local-source operation
  or typed descriptor, with rclone accounting/cancellation, instead of modifying
  generic operations for MEGA.
- Bind state to full source SHA-256 and byte size, the authenticated account's
  stable user handle, exact parent node handle and destination name. `MegaFS`
  already exposes `HashLookup`; resolve that handle after fresh authentication
  and reject a missing/wrong-type parent. A path/name match alone is insufficient.
- Preflight-hash the open source descriptor and check its metadata around hashing.
  Read/hash the actual upload stream as well, and refuse finalization if content
  differs. Size/mtime alone do not establish identity. Source changes must not
  silently corrupt an existing upload session or publish a mixed-version file.
- Verify every skipped native chunk against its saved MAC during the actual source
  read, using `Upload.VerifyAcknowledgedChunk`. A source could change during an
  interrupted attempt and later return to its original full-file hash; that hash
  alone cannot authenticate the bytes represented by earlier acknowledgements.
- The preflight also records a SHA-256 fingerprint per 128 KiB source block.
  The actual reader validates a complete block before exposing any of its bytes
  to upload workers. An end-of-stream hash alone could detect changes only after
  unknown server offsets had accepted different ciphertext; verifying before
  transmission prevents that hazard. Fingerprints are rebuilt per process, held
  only in memory, and bound by the full source SHA-256 in the encrypted checkpoint.
  They consume 32 bytes per 128 KiB (256 KiB for 1 GiB; at most 256 MiB for the
  supported 1 TiB source cap), plus one 128 KiB read buffer. Source payload buffers,
  crypto/MAC state and runtime overhead are additional.
- Define skipped-byte accounting explicitly. Network-acknowledged bytes restored
  from a checkpoint, current-attempt source reads, current HTTP payload reads and
  current acknowledgements are separate counters. Keep existing completion rules.

## State codec and ownership

The MEGA backend now exposes `upload-resume remote:existing/directory
/absolute/source -o name=file.bin -o checkpoint=/absolute/private/state`, with
`-o checkpoint-interval=1s` (0 enables immediate coalesced flushes). It refuses an
existing destination name and requires HTTPS. It retains a committed tombstone,
verifies the exact confirmed node on repeated commands, and stops for inspection
on restored commit intent. Ordinary `copyto`/`Put` behavior remains unchanged.

The command installs cancellation for backend-command callers, applies
`--max-duration`, and joins workers/writes before signal exit. Its exit handler
cancels and waits; completion closes the wait channel before unregistering the
handler, avoiding the global exit-handler lock inversion. Local child-process
fixtures cover both SIGINT and abrupt process death (SIGINT on Unix only).

Keep serialization/encryption next to the dependency's private upload crypto state.
Use an authenticated envelope with a fresh cryptographic nonce and a domain-separated
key derived from the freshly authenticated account's master key, without exporting
or storing that master key/password. Bind the envelope/schema to the account. This
lets a fresh login unlock a checkpoint without a second persisted plaintext key.
A changed/unavailable account key must reject restoration, never silently replace
the session. Native tests must establish the envelope and permission behavior.

Use one stable OS lock file across atomic checkpoint replacements; do not unlink
the lock inode on completion while another process may be waiting for it. The
store uses native flock/LockFileEx, verified with subprocess fixtures. Encryption does not remove
the need for private directories, owner checks, symlink rejection and Windows ACL
validation. The private store is implemented under `backend/mega/internal/checkpoint`,
separate from backend behavior so native I/O can use platform-specific helpers.
Native Linux, Windows and macOS storage fixtures passed in run `39418887213`.
The local-source operation and serialized writer are implemented; their integrated
native/live validation remains a separate gate.

The store anchors file operations to `os.Root`, verifies ownership and private
permissions, refuses symlinks/hardlinks, and retains one OS-locked inode across all
atomic state replacements. Unix uses private modes, UID checks, flock and fsync;
macOS additionally uses F_FULLFSYNC for files. Windows creates owner/SYSTEM-only
protected ACLs at creation, pins non-reparse ancestor handles, and restricts storage
to fixed local NTFS volumes; files and replacement use write-through plus flushes.
An initialization marker prevents missing state from silently becoming a new upload.
Snapshots use private temporary files and durability barriers; a late error may
leave a complete newer snapshot, but never authorizes the caller to commit.

Offline fixtures cover atomic replacement, write/sync/close/rename/barrier failures,
short initialization writes, missing initialized state, unsafe directories, links,
cross-process exclusion and ownership recovery after process death. Native execution
must validate platform behavior before the store is exposed through an upload command.

The dependency now exposes `Upload.SealCheckpoint`, `Mega.OpenUploadCheckpoint`
and an independent acknowledgement bitmap. AES-256-GCM protects the complete
session/key/native-MAC state, using fresh 96-bit random nonces and an HMAC-SHA-256
key derived from the account master key under a versioned checkpoint domain and
stable account handle. The complete verified binding is authenticated as AAD.
The password-derived `Mega.uh` is deliberately excluded, including for saved-key
logins. No plaintext password/master key or identifying metadata is stored outside
the encrypted envelope. Invalid state yields a generic error without private data.

The development format caps envelopes at 64 MiB and resume sources at 1 TiB.
It validates the version, original key/MAC lengths, HTTPS endpoint, native layout,
source/destination binding and phase before returning a restored upload. Source
hashing, parent resolution, protected storage and locking remain caller duties.
Snapshot calls freeze the binding and cannot revert commit intent/committed phases.
Restored commit phases block data requests and finalization, and the confirmed node
cannot be changed. A live checkpointed session requires commit intent before its
single finalization call; callers must persist it before making that call.

Versioned state needs original upload key/nonce material, session URL, native chunk
layout/size, acknowledged native MACs, any completion handle, identity fields and
an explicit phase. Native chunk boundaries remain deterministic and unchanged.
Validate lengths, counts, offsets, supported version, endpoint scheme and account/
destination/source binding before sending data. Deep-copy mutable key/MAC slices.

`FinishContext` mutates crypto folding/key state. A data-resume snapshot must be
taken before finalization, never reconstructed by serializing that mutated state
after a failed commit. A resumed session rebuilds the cipher/folding objects from
the original material; it must not call `NewUploadContext` and substitute a new
upload URL while retaining old acknowledgements.

Treat state as sensitive capabilities and file keys. Use a private directory and
owner-only files (Unix permissions and verified Windows ACL behavior), authenticated
storage/integrity protection appropriate to the chosen key-storage design, atomic
replacement and durability barriers. Never save account passwords. Acquire a
cross-process OS lock for the entire operation; a PID-only stale-lock file is
insufficient. Reject unsafe paths, corrupt state and conflicting ownership.

## Upload/recovery state machine

1. **Uploading:** merge acknowledgements and their native MACs/handle as one
   consistent state. Coalesce checkpoint writes if desired, with a configurable
   flush interval; a crash may lose acknowledged progress but must permit exact
   ciphertext replay. Bound notifications/state buffers and serialize writes so
   an older snapshot cannot overwrite a newer snapshot.
2. **Preparing commit:** join upload workers and the checkpoint writer, verify
   source identity and complete MAC/handle state, then durably record commit intent
   before calling the final file-creation API. Failure to save intent stops before
   that API call. A stale background writer must not revert the phase.
3. **Commit intent persisted:** after a restart, report an uncertain outcome and
   never blindly repeat finalization. This includes a crash before the API call
   as well as a lost successful reply. Automated reconciliation, if later added,
   needs strong file-key/transfer identity and exact parent binding; filename and
   size alone do not prove which upload created an object.
4. **Committed:** persist the returned node identity or remove state durably.
   Failure to retire state must not turn a successful commit into an automatic
   second upload. Return a non-retryable, explicitly classified cleanup/uncertain
   result consistent with existing finalization safety.

Expired sessions and provider restart-required responses retain a clear unusable/
restart-required outcome. Do not manufacture success, silently discard evidence,
or copy acknowledged offsets to a fresh upload URL. Explicit discard/restart is a
separate action. Stop/cancellation and crash have documented state-retention rules.
Keep the old destination until a replacement commit is confirmed.

## Required tests and release decision

Write regression fixtures before implementing codecs and fault paths. Cover
tampered/version-mismatched state, changed sources, wrong accounts/parents, invalid
MAC/key lengths, duplicate ownership, interrupted writes, failed fsync/rename,
reordered writes, cancellation and every crash window around commit intent/reply.
Run native permission/locking checks on Linux, Windows and macOS. A write interval
is configurable; hashing and safe commit ordering are correctness requirements.

Only advertise durable resume after the two-process live gate and native state/
fault/integrity checks pass. If server semantics prevent safe recovery, record
that result and release the independently validated pacing/batching/retry work
without promising resume. Keep M3 integration separate in either case.

## Current integrated fixture coverage and next gate

The local TLS service fixture runs the real backend command, protected store,
production codec, native chunk encryption and finalization in fresh child
processes. It verifies a stopped upload resumes the same URL/key session and
skips its acknowledged prefix, reconstructs plaintext independently from the
committed file key/ciphertext, and checks SHA-256. Repeating a committed command
sends no new data or commit. Abrupt process death releases ownership and resumes;
Unix SIGINT joins cancellation/checkpoint work before exit. A provider commit
with a deliberately unusable reply leaves intent and is not repeated on restart.
These fixtures establish local code behavior, not provider session lifetime.

Additional offline tests cover missing/unsafe/lost state, disk faults at initial,
background, intent and committed saves, background write failure while workers
are active, coalescing/serialization, source mutation even with restored metadata,
MAC mismatches, pending-only accounting, bandwidth cancellation and request sizes
larger than token-bucket burst capacity. Existing accounting callers retain their
behavior; an additive context-aware API supports the explicit upload operation.
The explicit command also applies the ordinary hard/soft/cautious transfer-budget
admission rules to pending payload; hard cutoffs remain active during accounting.

Live protocol rerun `39418890708` failed before recording a case; cleanup also
failed. Cleanup-only run `39432815707` independently classified pristine stock
login as blocked/authentication. The isolated folder
`rfork-protocol-8097f0bbab2147e28329abfe5e0215d6` has **not** been verified absent.
Do not dispatch more upload probes until the test account is usable and that
exact folder can be checked/cleaned. Then validate the integrated CLI against
MEGA and independent stock downloads on all shipping platforms, including fault
recovery and source rejection, before any release or M3 bundle change.
