# M3 rfork settings validation

Status: complete, 2026-10-21. All three native packaged/live gates passed.
The validation snapshot is `24622fb474fa517f6b720561a2ec3a1e3cd241de` on temporary
branch `codex/m3-rfork-settings` in `alphazoic/alpha-rfork`. This is an isolated
M3 source snapshot for CI; it does not replace the rfork development branch or
change the original M3 remote/index.

[Native package and live recovery run](https://github.com/alphazoic/alpha-rfork/actions/runs/39459533295).

## Passed locally

- 57 settings, adapter and recovery tests: input validation/units/defaults,
  structured commit proof, retained checkpoints, no fallback, changing the resume
  preference, source/HTTPS refusals, partial CSV recovery and duplicate prevention.
- Five bundle/resolver tests and native CLI version check. All three promoted
  binary hashes match the standalone final native/live manifest.
- 419 upload/VPN regression tests.
- Full Electron UI regression suite: existing settings/order persistence,
  upload/download controls, catalog/retry/refresh behavior and shutdown cases.
- Isolated Linux packaged-app smoke: actual helper execution and stdin password
  obscuring; renderer/preload/provider orders; new settings save with custom sizes
  and zero values; invalid IPC rejection; dependency checks/reset; renderer reload.
  This local smoke preceded the final location hint, styling and complete
  diagnostic-settings report. Final native package gates below include them.
- `git diff --check` passed.

## Native packaged results

| Platform | Recorded checks | Independent stock SHA-256 checks | Actual M3 restart/resume | Cleanup |
| --- | ---: | ---: | --- | --- |
| Linux amd64 | 23 | 3 passed | passed | verified |
| Windows amd64 | 23 | 3 passed | passed | verified |
| Intel macOS amd64 | 23 | 3 passed | passed | verified |

Total: 69 recorded checks, including repeated UI checks before and after restart,
and nine independent stock-client SHA-256 checks. Ordinary payloads are 64 MiB
and empty; restart uses 9 MiB + 31 bytes, two workers, 1 MiB requests and a temporary
1 MiB/s cap. These are correctness tests, not throughput/default recommendations.

Receipts: `rfork-settings-runs/*-39459533295.json`; consolidated manifest:
`rfork-settings-native.json`. `rfork-settings-local.json` records that all 332
validation snapshot files match the workspace, excluding the isolated checkout's
`.gitignore`. Documentation added afterward does not affect the application.

## Native gate contract

Each supported amd64 platform builds an unsigned M3 installer and starts the
actual packaged app. It verifies Settings through real IPC and uploads at fixed
modest concurrency, with independent stock-rclone downloads/hashes. It then
interrupts a checkpoint upload, exits M3, starts a new application process against
that isolated profile and recovers the original session. A test-only lost
application-completion write leaves a committed hold; the next attempt must use
the tombstone without a duplicate upload or CSV row. Scoped cleanup and private
profile removal run even after failure. No checkpoint/config files enter artifacts.

The independent verifier is built from the official pinned rclone v1.75.2 source
archive after SHA-256 verification. Each receipt identifies the tested M3 commit,
platform, bundled executable hash and completed checks. Installer fingerprints
are included in the receipts. Every native job's independent cleanup step passed,
including private profile removal. Installers are retained under ignored
`validation-output/settings-39459533295/`; their download checksum results are
recorded in `rfork-settings-installers.json`; all three downloaded installers
match their native build fingerprints. Artifact receipts also match the saved
job receipts exactly.

These are unsigned development M3 1.2.4 packages with rfork `0.2.0-dev`. No release,
installation or automatic update was published. The original M3 working branch,
index and earlier `dist/` artifacts are preserved. Source is saved on the temporary
validation branch; standalone rfork's branch/source remain unchanged.

Earlier runs `39457871694` and `39458096006` were cancelled/superseded. The latter
caught a harness counter error mixing diagnostics with upload-completion events;
its Linux cleanup passed. The corrected final matrix above passed all platforms.
