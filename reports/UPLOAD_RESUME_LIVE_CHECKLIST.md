# Integrated live resume gate

This is the remaining gate, not a record of successful MEGA command tests.
Production source is `39ee917`. The encrypted protocol probe passed earlier at
`8947a62`, but the later probe failed before cases and stock login reported the
dedicated MEGA account blocked. Do not dispatch more uploads until that is resolved.

## Prerequisite cleanup

Run the existing manual `resume-protocol` workflow with `cleanup_folder` set to
exactly `rfork-protocol-8097f0bbab2147e28329abfe5e0215d6`. Its stock-client listing
must succeed; purge only that exact isolated folder if present and verify absence.
Keep the sanitized receipt, including a failed cleanup attempt if applicable.

## Fixed correctness workload

Use a new isolated UUID folder per native platform, with verified cleanup in an
always-run step. Reuse existing repository secrets and private configuration
handling; never publish credentials, checkpoints, raw private errors or upload URLs.
Build rfork and the independent stock verifier from pinned sources.

Start with one deterministic 9 MiB + 31 byte regular source file, 2 workers,
native requests or a fixed 1 MiB request limit, default data pacing and a 50 ms
checkpoint interval. Temporarily limit upload bandwidth to 2 MiB/s to create a
repeatable interruption window. These settings establish correctness; they do
not choose performance defaults. Record effective settings and exact byte counts.

1. Start the explicit command with an absolute source and private per-transfer
   checkpoint directory. Wait for initial state and an ensuing state replacement
   indicating progress, then stop before publication. An envelope-size change can
   trigger interruption, but is not proof of authenticated acknowledgement: the
   resumed command's counters must establish that separately.
2. Restart in a fresh process with the same account/parent/name/source/checkpoint.
   Require a positive `restoredAcknowledgedBytes`, successful commit, complete
   source-read count and pending bytes equal to size minus restored bytes.
3. Download through pristine stock rclone and compare SHA-256. Check exact node
   identity and one destination file. Repeat the command and require
   `already-committed` with no second node.
4. Repeat with abrupt process termination on all platforms. Test SIGINT separately
   on Linux/macOS. Verify ownership recovery and retained progress. Keep Windows
   console-signal behavior separate from `TerminateProcess` coverage.
5. After an interrupted attempt, alter source bytes while preserving size/mtime.
   Require rejection without publication; restore the original content, resume
   the original checkpoint and independently verify its eventual file.
6. Exercise an empty source and a short final block with independent stock hashes.
   Wrong destination/account/source binding and an existing name must reject.
7. Verify scoped remote cleanup and publish only sanitized stages/counters/hashes,
   source commit and native binary digests. Checkpoint/config temporary files must
   remain private and must never enter artifacts.

The local TLS child-process fixture already proves commit-intent persistence and
lost-commit-reply refusal with the real codec/store/command. If testing that fault
against MEGA, inject the lost reply only in a dedicated test transport, then use
fresh authentication and stock verification to establish the created node. Never
blindly replay a final API request or add a fault switch to the shipping CLI.

Passing short interruptions does not establish a general provider upload-session
lifetime. Expiry/restart-required errors must preserve state and require explicit
inspection. Do not publish a release or replace M3's bundle until integrated live
recovery and all native gates have passed.
