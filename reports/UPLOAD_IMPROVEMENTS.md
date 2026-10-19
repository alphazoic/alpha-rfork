# Upload improvement validation

Work begins from saved commit `2500ccc2fe0e117a95df1860355c1483408291a7`.
The baseline release and M3 bundles remain unchanged. This record distinguishes
offline checks from live-server and native-platform validation.

## Diagnostics stage — 2026-10-20

Implemented `--mega-upload-diagnostics` (default false). It emits bounded numeric
aggregates through the `megaUpload` JSON-log field. Counts distinguish source
reads, HTTP payload reads including retries, acknowledged native chunks and file
commit success. Durations include source reads, encryption, HTTP requests,
responses and retry waits; upload setup/data/commit/elapsed timings have explicit
boundaries. Worker durations overlap. No private upload identifiers are recorded.
CPU/RSS and TCP/TLS traffic remain external measurements. Pacing timing is reserved
for the separate data-pacing implementation.

Validation on Linux:

- Added diagnostics contract tests before implementation; the initial run failed
  to compile because the new APIs did not exist.
- Dependency crypto/HTTP/race suite passed, including retry byte accounting,
  disabled collection, private-field exclusion and parallel aggregate bounds.
- Backend upload race tests passed, including short-source diagnostic accounting
  and the existing worker cancellation/finalization checks.
- `bin/lint-rfork` passed for parent packages and local-dependency changes.
- `git diff --check` passed.

Commands: `bin/rfork-go test -race -count=1 -timeout 90s ./backend/mega -run
'^TestUpload'`; in `deps/go-mega`, `bin/rfork-go test -race -count=1 -timeout 90s
./...` via `RFORK_WORKDIR`; and `bin/lint-rfork`.

The HTTP fixture suite required execution outside the filesystem sandbox because
the sandbox denied localhost socket listeners. No live MEGA uploads, performance
claims or new Windows/macOS runtime validation are covered by this stage.
