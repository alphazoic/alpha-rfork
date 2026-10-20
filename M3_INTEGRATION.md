# Separate M3 integration checklist

No M3 files or bundled executables are changed by this fork. Promote a release
only after the recorded integrity/recovery gates and native target validation pass.
This document records the integration points inspected in the parent M3 tree;
they are not build dependencies of rfork.

1. Verify each artifact against its manifest/checksums and preserve its version,
   licenses and validation status. Place validated `rfork` / `rfork.exe` in
   M3's `bin/linux`, `bin/mac`, and `bin/win` directories. M3's package rule
   copies `bin/${os}` into `resources/bin`.
2. In `binPath.js`, resolve the existing logical `rclone` provider to the
   versioned rfork binary. Keep one selectable implementation in the fallback
   chain and preserve saved provider-order settings. An explicit bundle/version
   switch can restore the stock executable for rollback.
3. In `src/upload-engine.js` (`uploadFileWithRclone`), pass the configured
   `--mega-upload-concurrency` and explicit HTTPS selection. Retain
   `--transfers 1`, JSON statistics and existing interruption tracking. A full
   read/progress count is not proof of remote completion: wait for a successful
   process exit and obtain the file link afterward.
4. Preserve the finalization uncertainty classification across process exit.
   The current adapter reduces most nonzero exits to a generic error, and M3
   can then select another tool. An uncertain final commit must trigger remote
   reconciliation or explicit user action before another upload is attempted;
   it must not silently become an ordinary retry/fallback. Add an adapter
   regression test for this path.
5. Keep `src/rclone.js`'s compatible remote/obscure calls and verify import,
   refresh and quota consumers (`src/import-engine.js`, `src/account-manager.js`,
   `src/account-usage.js`). Interpret actual free quota from total and used:
   the upstream unsigned free-space field can overflow on over-quota accounts.
6. Test the adapter and packaged application on each supported OS: progress
   line buffering, success/failure/quota exits, share links, Stop, Skip,
   cancellation during a chunk and commit, restart after interruption,
   account rotation and fallback order. Check for duplicate destination files
   and ensure finished uploads survive share-link failures.
7. Exercise rollback with existing saved settings and confirm the selected
   binary's version in diagnostic output. Bundle the release only after those
   checks pass.

The fork's Linux smoke tests establish CLI compatibility and backend integrity;
they do not substitute for these application and packaged-OS checks.

## Implemented controls for the later M3 settings work

These controls are implemented in rfork; mapping them into M3 is a separate task.
No worker/pacing/request-size performance sweep is required before exposing them.
Preserve existing compatibility defaults and let the user experiment in M3.

| Setting | rfork interface | Default and contract |
| --- | --- | --- |
| Workers per file | `--mega-upload-concurrency` | 8; binary accepts 1–32 for compatibility. Follow the user's modest 5–12 working range and maximum 20 for M3 experiments. |
| HTTPS | `--mega-use-https` | true; ordinary uploads permit false, while encrypted restart-resume requires HTTPS. |
| Bundled request payload | `--mega-upload-request-size` | 0 for native requests, otherwise 1–64 MiB. Pass explicit units such as `4Mi` or `4194304B`; bare numbers mean KiB. A boost toggle can remember a nonzero size and use 0 when disabled. |
| Data-request pacing | `--mega-upload-pacing` | 10ms; nonnegative, 0 disables this delay. Shared by files on one backend instance, including retries; metadata/API pacing stays separate. |
| Additional data retries | `--mega-upload-retries` | -1 inherits low-level retries; 0 disables additional attempts, positive values set the per-file budget. This never permits repeating finalization. |
| Truncated-body replay | `--mega-upload-retry-body-errors` | false; opt-in replay of original ciphertext after an incomplete successful response body. |
| Numeric diagnostics | `--mega-upload-diagnostics` | false; `megaUpload` for ordinary uploads, `megaResume` for explicit resume. These counters are not proof of a successful commit. |
| Restart checkpoint interval | backend option `-o checkpoint-interval=1s` | Nonnegative duration; 0 flushes coalesced notifications immediately. Applies only to the explicit local-file resume command. |

The native crypto chunk layout remains fixed by MEGA. Request grouping is the
configurable counterpart to bundling; do not present it as changing that crypto
layout. The explicit source reader's 128 KiB verification buffer is also distinct
from megafork's configurable buffer setting. Resource bounds and fingerprint
overhead are documented in `RFORK_README.md`; generic `--max-buffer-memory` does
not cap these upload buffers.

## Explicit resume adapter contract

Resume uses `backend upload-resume remote:existing/directory /absolute/source`
with `-o name=leaf` and `-o checkpoint=/absolute/private/per-transfer-directory`.
It is not a resume flag on ordinary `copyto`. Initially it supports a regular
local file and refuses existing destination names. M3 must retain the opaque
per-transfer directory and the account/parent/name/source mapping across restart;
the binary owns encryption, atomic writes, OS locking and phase validation.

Treat `restoredAcknowledgedBytes` separately from current-attempt pending-byte
accounting. Their sum may drive a bounded progress display, but completion still
requires exit 0 and `committed` or `already-committed`. Compare node identities
without logging private checkpoint material. HTTP payload counters include retries
and must not be added to completed-file progress.

The backend command marks operation errors non-retryable at both retry layers,
so an uncertain transport reply cannot become retry exit 5. Binding/inspection
refusals use exit 6; standard not-found/quota classifications can take precedence.
Retain state on every failed resume attempt rather than inferring phase from the
exit code alone.
Retrying the identical checkpoint cannot silently repeat a commit: restored
intent stops for inspection, and a committed tombstone verifies its exact node.
Do not delete state, switch to a new checkpoint or fall back to another uploader
to bypass that result. Preserve this classification and test it in the adapter.
Share-link retrieval can fail after the file is committed; it must not cause a
second upload. Keep all M3 implementation/package changes out of this rfork stage.
