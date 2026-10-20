# Configurable rfork uploads

Open Settings → rfork Uploads. Save changes before starting a new upload run.
The running queue keeps its original settings snapshot. These controls affect
rfork uploads; megatools, MEGAcmd, account browsing and downloads keep their own
settings. Existing tool orders still use the saved `rclone` provider ID.

The main card offers workers (1–20, default 8), HTTPS, and request bundling/boost.
Bundling is off by default; when enabled its maximum request payload accepts
custom values from 1–64 MiB. Turning it off remembers the chosen size. Larger
requests preserve MEGA's native encryption chunks. The memory hint estimates
request buffers and encryption scratch, not total application memory.

Advanced controls cover data pacing, extra data retries, incomplete-response
replay, numeric diagnostics, source read-ahead, payload bandwidth, connection
admission, HTTP rate/burst, connection/idle timeouts, attempt duration/payload
limits and cutoff mode, HTTP/2, connection reuse and progress update frequency.
Numeric units are explicit. Zero disables the corresponding limit or pacing;
extra retries use -1 to inherit M3's existing low-level retry value of one.
Whole-file retry remains fixed at one attempt. Diagnostics are sanitized numeric
aggregates, and retry payload is separate from completed file progress.

The source read buffer applies to ordinary uploads. Resume uses its own fixed
source verification reader, so the read-ahead control is disabled in that mode.
The ordinary no-progress watchdog runs only after observed data progress and
before all source bytes are read, with allowance for configured pacing/rates.
Resume uses its I/O and attempt limits because hashing and commit stages do not
provide continuous upload progress. Whole-attempt limits can stop preparation as
well as data transfer; failures retain a destination hold rather than bypass a
limit through another uploader.

## Restart/resume

Enable Keep restart checkpoints to use rfork's explicit local-file operation for
new transfers. It requires HTTPS, a regular local source, an existing destination
directory and a destination name that does not already exist. Ordinary uploads
retain their existing replacement behavior.

Checkpoint interval defaults to one second; zero flushes coalesced progress
immediately. The default location is M3's private local profile. Change location
while idle to select a local filesystem; Windows requires fixed local NTFS.
rfork creates each private transfer directory with native permissions/ACL and
owns encryption, locking and state validation. Existing transfers keep their
original paths when preferences change. Do not delete their state or original
source files. Split archives use unique directories so a later queue cannot
regenerate a different source over retained parts.

Use **Upload recovery…** in the upload sidebar. Resume original transfer uses
the saved account, destination, source and checkpoint; the original account
password is read from M3's account CSV or entered in the recovery dialog.
Performance controls can change between attempts. Turning checkpoints off does
not discard existing transfers, and HTTPS must still be enabled to resume one.

Recovery initially reports current-attempt payload; authenticated restored bytes
are confirmed at completion. A committed checkpoint verifies its saved node
instead of uploading again. M3 records completion durably before clearing its
hold; retained opaque checkpoint directories are kept. Missing/expired sessions,
changed content or uncertain final commits stop for inspection. Stop and Skip
retain state and wait for process closure. No other tool/account is automatically
selected to bypass a retained resume attempt.

**Inspect / discard hold** requires inspection of that exact account/destination.
If keeping a remote file, remove its source from any pending queue. A fresh
upload is appropriate only after remote absence/removal is established.
Discarding the M3 hold does not delete private checkpoint files. Share-link
failure after a confirmed commit does not initiate a second upload.

## Build and validation

M3 now pins `v1.75.2-rfork.0.2.0-dev`, with the exact three binaries recorded in
`bin/rfork-bundle/manifest.json`. This is a development build, not a new release
tag. The earlier alpha's manifest is preserved in
`rfork-alpha-rollback-manifest.json`; a local complete rollback copy is retained
under ignored `rfork/build/m3-alpha-rollback/`.

See [validation status](rfork-settings-validation.md) for M3-specific checks.
Standalone binary native/live integrity results do not by themselves establish
that a new M3 package has passed its application gates. The implementation plan
is in [rfork-settings-plan.md](rfork-settings-plan.md). No performance sweep or
1 GiB comparison is part of this integration.
