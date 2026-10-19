# Separate M3 integration checklist

No M3 files or bundled executables are changed by this fork. Promote a release
only after the recorded performance gate and native target validation pass.
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
3. In `src/upload-engine.js` (`uploadFileWithRclone`), pass the measured
   `--mega-upload-concurrency` and explicit `--mega-use-https=true`. Retain
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
