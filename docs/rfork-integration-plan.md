# Plan: integrate rfork into M3

The later configurable upload and checkpoint integration is also complete; see
[rfork-settings.md](rfork-settings.md) and its linked native validation receipts.
The stages below describe the earlier alpha integration.

Status: all three integration stages are complete. See [rfork-bundle.md](rfork-bundle.md)
for the bundle and [rfork-adapter.md](rfork-adapter.md) for adapter/recovery checks.
[rfork-package-validation.md](rfork-package-validation.md) records successful
native packaged application and live MEGA validation on Linux x64, Windows x64
and Intel macOS. Testing credentials remained in GitHub secrets. No M3 release
was published.

## Outcome and scope

Replace the bundled stock rclone implementation with validated rfork for Linux,
Windows and Intel macOS, all amd64/x64. Keep one provider in the existing
fallback chain, preserve saved tool orders, and display **rfork** to users.
Use HTTPS and eight native upload workers per file. M3 still controls how files
and accounts are queued. rfork remains a separate project; M3 receives binaries,
licenses and provenance rather than its Go sources or build dependencies.

Standalone validation is complete. This work verifies M3's adapter, other
consumers of the binary, and packaged application behavior.

## 1. Promote the exact validated artifacts

- Pin the version, per-artifact source provenance, SHA-256 and validation links
  from `rfork/reports/platforms.json` and the live reports. In particular, use
  the **native-tested Windows artifact**, whose hash differs from the earlier
  cross-build. Do not use the old Windows release archive by assumption.
- Copy validated executables into `bin/linux/rfork`, `bin/win/rfork.exe` and
  `bin/mac/rfork`, preserving executable permissions where applicable. Add the
  required upstream/dependency license notices and a bundle manifest. Verify
  hashes before and after copying.
- Add a bundle check for missing files, incorrect hash, executable format,
  architecture and embedded version. Record the resolved binary/version in
  diagnostics without account credentials.
- Preserve existing published rfork tags/archives. Retain the previous M3
  bundle revision as the rollback point; rollback is an explicit bundle/code
  revert, not an automatic retry through slow stock rclone.

Gate: all three bundled binaries match their validated fingerprints and the
manifest identifies their exact provenance.

## 2. Switch resolution and visible naming

Files: `binPath.js`, `index.html`, affected renderer/log formatting.

- Resolve M3's existing logical `rclone` provider to `rfork`/`rfork.exe` in
  development and packaged `resources/bin` paths.
- Keep persisted provider IDs such as `rclone` and `data-tool="rclone"` so
  existing upload, refresh and browsing orders and forced selections still
  work. Change their visible label to `rfork`; use that name in diagnostics.
- Preserve user-selected priorities. Do not add a fourth automated fallback or
  reset settings. A missing rfork binary must be reported through normal tool
  failure handling, not silently select an unrelated system rclone.

Gate: old saved settings select the intended binary on every supported OS.

## 3. Adapt uploads and completion handling

Files: `src/upload-engine.js`, `src/rclone.js`, and the existing progress and
process-management helpers where needed.

- Pass explicit `--mega-use-https=true`, `--mega-upload-concurrency 8` and
  `--transfers 1`. Set whole-file retry policy deliberately so M3's fallback
  logic and rfork do not independently replay the same file; retain safe native
  chunk retries. Keep JSON transfer statistics.
- Buffer stderr across chunks, parse only complete JSON lines, and flush the
  final line on close. Use the same measurements for displayed progress and VPN
  recovery. Bound retained diagnostics and exclude credentials/share keys.
- Treat byte counters as progress. Record completion only after confirmed
  successful process closure. Check the existing fast-success/"ghost upload"
  heuristic against fast rfork uploads and genuine skipped/existing objects.
- Keep committed uploads successful if subsequent share-link retrieval fails;
  preserve the existing completed-upload/blank-link behavior without reupload.
- Normalize setup, upload and link paths consistently across all three tools.
  The current upload adapter adds `/Root/` for rclone, while browsing strips it;
  rfork paths are relative to the account root. Verify new destinations and
  compatibility with existing folders/CSV records. Do not silently move old
  files or rename legitimate folders named `Root`.
- Preserve Stop, Skip and network process tracking, and wait for the child to
  close before starting conflicting work. Never record a cancelled upload as
  completed or delete its local source on the strength of progress alone.

Gate: a forced rfork upload reaches the intended folder and yields one correct
file/link/CSV entry, including fast and empty uploads.

## 4. Preserve uncertain outcomes through M3's fallback loop

Files: `src/upload-engine.js`, `src/upload-vpn-session.js`, relevant queue/status
handling and `src/upload-recovery.test.js`.

- Recognize rfork's explicit finalization diagnostic: `remote outcome may be
  uncertain, inspect before retrying`. Preserve its meaning across process exit;
  an exit code alone is insufficient to distinguish it from other failures.
- Propagate an upload-uncertain result before normal network retry, tool
  fallback, quota/stall classification, or account rotation, with VPN recovery
  **both enabled and disabled**. The current generic upload uncertainty guard
  only applies when that recovery policy is enabled.
- For the first integration, stop the queue with the account, destination and
  filename needed for inspection. Retain pending/local files and do not write a
  success CSV row. Do not automatically reconcile by size alone or blindly
  restart an interrupted/uncertain file after app restart. Reuse the existing
  attention/error flow rather than inventing a new recovery subsystem.
- Persist the minimal in-flight account identifier and destination before
  starting the child, using existing session storage where possible. A crash or
  forced Windows process termination must leave enough information to hold the
  file for inspection after restart; do not duplicate stored passwords.
- Confirm ordinary definite pre-commit failures still follow the configured
  fallback order and explicit quota failures retain existing account policy.

Gate: an uncertain commit can never silently cause a duplicate upload, a new
account, a success row, or local source deletion.

## 5. Verify the other consumers and UI

- Exercise password obscuring and remote syntax in `src/rclone.js`; preserve
  escaping and keep credentials out of displayed command lines. Use stdin for
  password obscuring when adapting that call.
- Test account refresh and usage queries in `src/account-manager.js` and
  `src/account-usage.js`, plus listing/file-link generation in
  `src/import-engine.js`. Their existing provider ID must continue to work.
- Keep used-space accounting correct. Where free space is consumed, derive and
  clamp it from verified total/used values; do not trust an unsigned overflowed
  `free` field on an over-quota account.
- Update tool-priority labels and explanatory text to reflect the bundled fork
  and its upload parallelism. Start with the tested eight-worker default rather
  than adding another settings control.

Gate: refresh, usage, browsing and links still work when rfork is forced and
when selected by fallback; saved orders survive restart.

## 6. Run focused integration checks

- Add adapter/process fixtures for split JSON, missing/final progress records,
  fast success, failed link lookup after success, definite failures, quota,
  cancellation, spawn errors and uncertain finalization. Include VPN recovery
  on/off and assert invocation count, account changes, CSV writes and source
  retention. Extend existing recovery fixtures rather than mirroring Go tests.
- Cover cross-tool folder identity and legacy saved provider settings. Test
  development and packaged path resolution for Linux, Windows and macOS.
- Run focused tests, then existing `test:vpn-workflows`, `test:vpn` and relevant
  renderer checks to catch regressions in shared process/recovery code.
- Through M3's actual upload adapter, force rfork for a generated payload,
  download independently and compare SHA-256. Exercise a definite failure that
  advances to the next configured tool. Check Stop/Skip and completed-upload
  handling. Use isolated UUID folders and verify cleanup.

Gate: the application integration passes; standalone speed/crypto benchmarks
do not need to be repeated without a relevant uploader change.

## 7. Validate packaging and prepare the M3 update

Files: `package.json`, `.github/workflows/build.yml`, bundle checks and a
non-publishing native validation workflow.

- Confirm `extraResources` places the executable, manifest and notices under
  `resources/bin` and excludes rfork's source checkout/caches. Verify installed
  executable permissions and the resolver's packaged path.
- Make x64 targets explicit. The current release matrix uses `macos-latest`
  and implicit Electron architecture; align the macOS runner/app target with
  the validated Intel binary. Do not ship an unvalidated ARM64 helper/app
  combination. ARM64 support is a separate validation task.
- Run native adapter checks and packaged smoke checks on Windows and Intel
  macOS through GitHub Actions, plus Linux locally/CI. Use manual, non-publishing
  checks before the existing tag-triggered release workflow publishes anything.
- Live M3 CI checks need the testing-account secrets in the repository that
  runs them; rfork repository secrets are not automatically shared with M3.
  Keep them out of ordinary pull-request tests and never use production account
  CSV data. This is the only anticipated external setup for native live checks.
- Verify rollback restores the earlier bundle/provider behavior and saved
  settings. Save the integration results, checksums and exact tested artifacts
  for the M3 release notes.

Done when all three supported x64 packages resolve the validated rfork binary,
the M3 upload and fallback checks pass, uncertain outcomes cannot be replayed
automatically, other binary consumers work, and native package smoke results
are recorded. Publishing an M3 release follows the user's release instructions.
