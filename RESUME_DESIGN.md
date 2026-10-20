# Restart-resume investigation and implementation contract

Status: design/investigation only. Durable resume is not implemented or advertised
as supported. Final batching/live checks are being resumed in the user-supplied
temporary repository `alphazoic/alpha-rfork`; the original account's blocked runs
remain recorded separately.

## Evidence and missing protocol gate

The saved live receipt `reports/upload-protocol-39397241665.json` establishes
multi-chunk POSTs, replay of an accepted nonterminal offset, and recovery of a
usable terminal handle from identical ciphertext. Both files passed independent
stock-client SHA-256 checks. These requests ran in one process/session.

The reference SDK persists upload URLs, crypto/MAC state and upload tokens in its
transfer cache (`src/transfer.cpp`); its mechanism is useful evidence, not proof
of this fork's process-restart behavior or any guaranteed server session lifetime.

Next live gate: create an isolated session and upload part of a file in process A;
write sensitive state to a private runner-temporary file, end A, then authenticate
freshly in process B and finish the same URL/key session. Test short delays,
unacknowledged-but-accepted data, a lost multi-chunk terminal response and expired/
rejected sessions. Independently download/hash and verify scoped cleanup. Record
the tested delays; do not infer a universal expiry time from the URL or a short
successful pause. Never put the sensitive state in logs, receipts or artifacts.

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
- Define skipped-byte accounting explicitly. Network-acknowledged bytes restored
  from a checkpoint, current-attempt source reads, current HTTP payload reads and
  current acknowledgements are separate counters. Keep existing completion rules.

## State codec and ownership

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
