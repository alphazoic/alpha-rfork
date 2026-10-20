# rfork adapter

The current configurable adapter and explicit checkpoint recovery are described
in [rfork-settings.md](rfork-settings.md). The stage-2 record below describes the
earlier alpha adapter; its fixed settings are now compatibility defaults.

M3's existing `rclone` provider ID now invokes the bundled rfork through a
dedicated upload adapter. Settings IDs and tool order remain compatible.

## Upload and retry policy

The adapter uses one explicit `copyto` destination relative to the MEGA account
root, HTTPS, eight native chunk workers, and one simultaneous file. It passes
`--retries 1 --low-level-retries 1`: rclone's operations.Copy uses the latter
setting to repeat entire file copies as well as configuring go-mega's request
retry count. In the pinned fork, this still permits one ciphertext-preserving
retry per native chunk, while preventing a second complete file attempt inside
the child process. M3 controls subsequent tool selection.

`--ignore-times` forces an actual upload rather than silently accepting an
existing file with matching size/time. Replacement follows rfork's existing
commit-new-before-removing-old behavior. A failed removal after commit is held
for inspection, since the new file may already exist.

Login parameters are supplied to the upload/link processes through their
environment rather than command arguments. Inherited `RCLONE_*` overrides are
removed so a system config, dry-run option or other ambient setting cannot
change M3's upload operation. Password obscuring uses stdin, including UTF-8,
and shared on-the-fly remote parameters quote commas and doubled quotes.

## Progress and completion

UI progress and VPN recovery use the same bounded JSON-line decoder. It handles
split UTF-8, split records and final records without a newline. Malformed or
oversized messages do not become progress or unbounded retained logs.

Source byte counters are not proof of remote completion. Success requires a
confirmed process close with exit zero, with no contradictory finalization
diagnostic. Fast and empty uploads do not need to emit a periodic statistics
record. Link lookup follows the upload; a failed lookup preserves the committed
file and records the existing blank-link CSV result without uploading again.

## Uncertain results and restart

Before starting rfork, M3 atomically writes `upload-recovery.json` in the selected
data folder. It contains the account identifier, local source, destination,
size, timestamp and state; no passwords, obscured passwords or share keys.

- `in-flight`: the child may still upload or may have been interrupted.
- `committed`: the child confirmed success, but M3 has not yet recorded its CSV
  row. This state also protects the gap between commit and local bookkeeping.
- `uncertain`: completion cannot be established from the child result.

The entry is removed only after successful CSV recording, or a definite failure
before upload (for example a missing executable or failed login/session setup).
Explicit quota responses preserve the existing account policy. Finalization
uncertainty and old-version-removal failures take priority over quota text.
Unknown transfer errors hold the file instead of guessing from its byte count
or generic exit code. Earlier retry diagnostics cannot override a later unknown
error. Proven pre-commit failures retain normal fallback with VPN recovery on
or off; uncertain outcomes stop before fallback, account rotation or replay.

On a later Start, M3 checks the journal before uploading. If an entry remains,
the native **Inspect interrupted uploads** dialog lists its account, destination
and source. The default keeps uploads paused. Explicit confirmation allows new
uploads after the user ensures earlier processes have stopped and checks the
destinations: remove a remote copy before
retrying it, or remove the corresponding local file from the queue if keeping
the completed remote copy. Cancel and stale/concurrent reviews retain the hold.
The backend also checks the journal independently of this renderer flow.

Stop and Skip wait for confirmed process closure; the rfork adapter escalates a
child that ignores termination rather than starting another transfer alongside
it. Skip can continue with other destinations on the same account, but the
skipped destination remains held for later inspection. Stops/failures preserve
local sources and unfinished archive parts. A confirmed archive part is deleted
only after its CSV row is written. This journal is an inspection safeguard,
not chunk-resume or automatic queue restoration; restage retained sources/parts
after a restart and inspection.

## Paths and other consumers

rfork and MEGAcmd paths are relative to the actual account root; megatools adds
its virtual `/Root` component. Upload setup, transfer and link lookup now agree
on the destination. Browsing/link fallback uses the source provider when
translating paths, so a real folder named `Root` (including legacy nested
folders) is preserved. Existing cloud folders and CSV links are not moved.

Usage queries validate nonnegative safe used-byte counts. The adapter does not
consume the upstream unsigned `free` field, which can overflow on an over-quota
account. Refresh, usage and browsing retain their existing provider IDs.

## Validation and remaining work

- `npm run test:rfork-adapter`: 44 checks passed, covering flags/paths, split and
  absent progress, fast/empty success, link failures, definite fallback, quota,
  commit uncertainty with VPN recovery enabled/disabled, restart holds, review
  acknowledgement, cancellation, archive-part retention, and other consumers.
- The tests run the actual bundled CLI for UTF-8 stdin obscuring and drive the
  real M3 upload engine against a local-only destination, comparing SHA-256.
  Local fixtures do not claim live MEGA account validation through M3.
- `npm run test:vpn`: all 417 existing and extended checks passed.
- The isolated Electron fixture passed, including the new review IPC flow:
  declining retains the journal and explicit inspection confirmation clears it.

Live uploads **through packaged M3** passed on Linux x64, Windows x64 and Intel
macOS, with independent stock-rclone download hashes, browsing, account refresh,
share links, Stop/restart holds and scoped permanent cleanup. See
[the native package report](rfork-package-validation.md). Standalone rfork live
validation remains recorded in the stage 1 bundle. No M3 release was published.
