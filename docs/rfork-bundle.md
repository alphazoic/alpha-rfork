# M3 rfork bundle

The current bundle pins `v1.75.2-rfork.0.2.0-dev`; its final standalone native/live
receipts and hashes are in `bin/rfork-bundle/manifest.json`. M3-specific validation
of the new settings/recovery is tracked in [rfork-settings-validation.md](rfork-settings-validation.md).
The stage-1 alpha record below is historical. Its original manifest is preserved
in `rfork-alpha-rollback-manifest.json`.

The existing `rclone` provider ID resolves to bundled `rfork` / `rfork.exe`.
Saved upload, refresh and browsing orders keep their existing IDs; Settings,
upload priority/force chips and tool diagnostics display **rfork**. The binaries
also serve the existing obscuring, usage and browsing consumers through the
same resolver. Their live application behavior is part of subsequent stages.

## Pinned artifacts

Version: `v1.75.2-rfork.0.1.0-alpha.1`; all targets are amd64/x64.

| M3 path | SHA-256 |
| --- | --- |
| `bin/linux/rfork` | `8c83896b7f8a2a0c23c3208eda6ec837998452fb384eb00f4cf551c4da48ef24` |
| `bin/win/rfork.exe` | `979483bf107b5bf321d7760c267e67d1ae8c6c486dd67d098d914fc760c27f9f` |
| `bin/mac/rfork` | `15e800baaea0be80f846732e84c82bdb385a9e8d185b90214f2e6bff57c7b365` |

Linux uses the binary independently verified in the 2 GiB live upload test.
Windows and Intel macOS use the exact GitHub artifacts from native live tests.
The selected Windows binary is distinct from the earlier, unexecuted cross-build.

`bin/rfork-bundle/manifest.json` records upstream/source references, per-target
CI build commits where available, hashes, native validation links and the prior
M3 revision/stock-binary hashes. The shared directory includes rclone and go-mega
license notices and the corresponding sanitized live-validation receipts.
Nothing here requires the separate rfork checkout at runtime or build time.

## Checks

```sh
npm run check:rfork
npm run test:rfork-bundle
npm run test:vpn-workflows
node scripts/test-vpn-ui.cjs
```

The bundle check verifies all three files' size, SHA-256, executable format,
amd64 machine type, embedded version, executable permission, validation receipt
and license copies. It runs `version` only for a compatible native x64 binary;
it never runs foreign-platform executables or logs account data.

The tests cover development/packaged resolution on all three OSes, the existing
MEGAcmd/7-Zip overrides, rejection of corrupted/missing/wrong-target artifacts,
and a staged packaged-resources layout. The isolated Electron fixture verifies
the visible labels and forced selection, then saves/reloads existing tool-order
settings and checks that the stored `rclone` IDs and order remain intact.
Its network/VPN/account operations use fixtures.

Stage 1 verification on Linux: five bundle/resolver tests passed, all 145
workflow regression tests passed, and the Electron UI fixture passed. The
bundled Linux CLI returned the pinned rfork version. Native Windows/macOS
standalone validation is recorded in the bundle; M3 package validation remains
stage 3.

For an unpacked application's resources directory, on its matching native OS:

```sh
npm run check:rfork -- --resources /path/to/resources
```

`package.json` copies platform helpers to `resources/bin` and shared notices to
`resources/bin/rfork-bundle`. The separate metadata directory avoids colliding
with the Unix executable `resources/bin/rfork`. The application logs the bundled
version and resolved path at startup; Unix permission repair skips metadata.
Actual packaged execution and live M3 uploads passed on all three supported x64
targets; see [the native package report](rfork-package-validation.md).

## Rollback and remaining stages

The previous stock executables are recoverable from M3 revision
`010faa27b96f2eeb6ca5c52234c1b629a4d95ce1`; their original paths and checksums
are recorded in the manifest. Restore the earlier bundle and resolver together
through a reviewed code/binary revert. There is no automatic stock-rclone
fallback and no dependency on a system-installed executable.

Stage 2's adapter, progress, destination and uncertain-finalization/restart
safeguards are implemented; see [rfork-adapter.md](rfork-adapter.md).
Stage 3's native M3 package and live adapter checks passed on Linux, Windows and
Intel macOS. The package report identifies the exact tested source and installers.
