# M3 packaged rfork validation

The manual **M3 rfork native validation** workflow builds unsigned x64 Linux DEB,
Windows NSIS and Intel macOS DMG installers without publishing a release.
The integration branch also runs this workflow on push. Pull requests run the
offline checks only. The live matrix runs one OS at a time to isolate the testing
account. ARM64 builds are rejected by the packaging hook until their helpers are
separately validated.

Each job verifies the pinned bundle, runs the native adapter regressions, restores
and checks the original rclone binaries from the recorded rollback revision,
then launches the actual unpacked application produced alongside the installer.
A local main-process inspector loads the external test probe; production M3 has
no test entry point. The probe verifies the renderer/preload, saved provider IDs,
packaged resolver, helper execution, licenses, evidence and checksum. Its isolated
Electron profile never reads the user's account CSV or application settings.

For live validation add `RFORK_MEGA_EMAIL` and `RFORK_MEGA_PASSWORD` to **M3's**
repository secrets. Credentials are consumed only outside pull requests. M3's
real packaged upload engine uploads a generated 64 MiB Unicode-named file and an
empty file, generates links, records CSV entries and clears successful journal
records. The original stock rclone independently downloads both files for
SHA-256 comparisons. M3's browsing and storage-usage consumers are checked too.
Account creation is guarded in the external harness; no new account is registered.

The probe also interrupts a real 128 MiB upload after progress, waits for process
closure, checks source retention and the persistent hold, and confirms a second
Start cannot replay the interrupted upload. Native adapter fixtures cover definite
failure fallback, Skip, failed exports and uncertain completion. Cleanup purges
only the generated UUID folder and checks its absence independently; an always
step repeats cleanup after a failed probe and removes the temporary profile.
Purges use explicit permanent deletion. On Linux, a guarded metadata cleanup
also removes older `m3-ci-UUID` fixtures from Trash only when their contents are
the known payload names; unrelated Trash entries are retained. Two preliminary
fixture folders were removed and their absence verified in the final run.
Only sanitized JSON reports and installers are uploaded as artifacts, retained
for seven days. Installer SHA-256 receipts identify the exact artifacts tested.

Local offline package check, after an unpacked build:

```sh
node scripts/test-rfork-package.cjs /absolute/path/to/linux-unpacked/m3
```

The bundle rollback is an explicit revert of the integration code and resources
to `010faa27b96f2eeb6ca5c52234c1b629a4d95ce1`; it is never an automatic slow
fallback. `check-rfork-rollback.cjs` verifies the original helper hashes and both
development/packaged resolution with the saved `rclone` provider ID on all OSes.
It also writes the current native stock binary to a separate verifier directory.
The stock binaries and old resolver are identical in GitHub's older
`0d44202040297cd96787304fc0d26f452e0837b0` revision; CI retrieves them from that
reachable commit and verifies their pinned hashes, including the resolver source.
The full application rollback point remains the local `010faa27…` revision.

GitHub's default branch predates twelve existing local application commits. The
validation branch therefore snapshots the current application sources onto the
GitHub base, excluding the previously tracked generated `dist/` directory.
Neither the default branch nor the local commit history is rewritten.

No M3 version tag is pushed by validation. The release workflow still requires
the user's release/tag instructions. Published artifacts must be built from the
validated integration revision; a later source change requires another run.

## Current evidence

All three native jobs passed in [run 39290699289](https://github.com/mega-fork/M3/actions/runs/39290699289),
validated on 20 October 2026 (Asia/Phnom_Penh), from source commit
`2cfa496852f7ab5e4611a35e53e18e47fc3df397`. See the
[sanitized CI receipt](rfork-stage3-ci.json) for individual checks, independent
payload hashes, pinned helper fingerprints and installer receipts.

Each OS passed five bundle tests and 11 packaged/live checks. All 44
adapter/recovery tests passed on Linux/macOS; Windows passed 43 and skipped the
Unix-only SIGTERM-resistance fixture. Its live Stop/restart check still passed.
The checks include actual-app startup, saved provider IDs, upload/empty-file
completion, CSV records, independent stock-rclone SHA-256 comparisons, browsing,
usage, account refresh, share-link generation and Stop/restart no-replay holds.
Cleanup passed on every OS. All three rollback binary hashes and original
development/packaged resolvers were verified too.

| Platform | Tested installer | SHA-256 |
| --- | --- | --- |
| Linux x64 | `M3_1.2.4_amd64.deb` | `4f422c917a1b3c8eb38a38c89dd1ad0f2b1c323f4acf29b4c7c6e059835069e1` |
| Windows x64 | `M3 Setup 1.2.4.exe` | `d6fcc88ba2bf90163b27226aec53685fe751b0e0caf6287c1a64ded886ab6fe2` |
| Intel macOS | `M3-1.2.4.dmg` | `9a41487cf7149890dc36741d8e7dea7ebb89c78d29b6ef7f1e86cf7e1f92b13b` |

Verified installer copies and JSON receipts are saved outside Git under
`validation-output/ci-39290699289/m3-rfork-{linux,windows,macos-intel}-x64/`.
Use these CI artifacts for the final tested revision. The earlier local Linux
DEB was also extracted and smoke-tested; its separate
[preliminary local receipt](rfork-stage3-local.json) predates the final CI build.

The validation branch is `codex/rfork-integration`. Documentation-only commits
after the tested revision do not change packaged application sources or trigger
another validation run. No release was published and no main branch was changed.
