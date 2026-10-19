# rfork alpha validation

Tested on Linux amd64 with Go 1.26.9. Upstream base: rclone 1.75.2,
verified against all 2,621 official release files; see [UPSTREAM.json](../UPSTREAM.json).
The source and dependency baselines are preserved as local Git tags.

## Correctness

- The credential-free upstream suite passed in 180 packages with no failures.
- Worker orchestration and patched go-mega crypto/HTTP fixtures passed race
  detection. Cases cover bounded read-ahead, buffer ownership, out-of-order
  completion, short reads, peer cancellation, shared-client isolation,
  ciphertext-preserving retries and lost commit responses without replay.
- Lint reported zero issues in the changed parent packages and dependency diff.
- Linux CLI checks passed: rfork version, MEGA flags, stdin password obscuring,
  local copy/hash, JSON statistics and failed-copy exit status.
- Live uploads of 0, 1, 15, 16, 17, 131071, 131072, 131073 and 8388639 bytes
  passed independent megatools download/authentication and SHA-256 checks.
  Separate 8388625-byte files passed with 1, 2 and 8 workers; the boundary
  sweep used 4 workers. The sweep observed the requested 1/2/4/8 bulk sockets.
- Overwriting one destination produced one replacement object with the correct
  hash. Ordinary share-link generation passed. Two simultaneous files using
  four workers each passed independent download hashes.
- A live 512 MiB upload was interrupted after at least 8 MiB of reported
  progress. The process stopped 0.004 seconds after SIGINT, and no completed
  destination was present. Context cancellation and worker joining are tested
  separately in the in-process race fixtures.
- The smoke test's UUID remote folder was hard-deleted, its absence verified,
  and generated local payloads removed.

Raw evidence: [smoke.json](smoke.json), [cli.json](cli.json),
[offline.json](offline.json). Independent megatools downloads occasionally
encountered transient SSL failures; the runner records these and retries only
transport failures. MAC and hash failures are never accepted or retried away.

Live testing exposed and fixed two real edge cases: the inherited upstream
empty-file aggregate MAC, and opaque completion tokens beginning with `-`.
Both have reproducing regression tests. An additional failed run was a
benchmark assertion error: it rejected upstream's valid `mega.co.nz` links.
[smoke-link-check-diagnostic.json](smoke-link-check-diagnostic.json) preserves
that run; [smoke.json](smoke.json) is the complete passing rerun.

## Performance

The sweep used the same 512 MiB random payload, account and VPN interface
(`proton0`), one file per process, no top-level retries, and no competing
build/lint jobs. Stock and rfork explicitly used HTTPS. Megatools used its normal
HTTP bulk transport, verified by TCP bytes; it is the practical fast-client
reference rather than an isolated HTTPS/chunk-count comparison.

| Run | Whole-file seconds | MB/s (decimal) | Bulk transport |
| --- | ---: | ---: | --- |
| stock-a | 325.4 | 1.65 | HTTPS |
| rfork-1 | 366.7 | 1.46 | HTTPS |
| rfork-2 | 170.9 | 3.14 | HTTPS |
| rfork-4 | 141.9 | 3.78 | HTTPS |
| rfork-8 | 51.3 | 10.47 | HTTPS |
| megatools-5 | 53.8 | 9.98 | HTTP |
| selected-a | 91.6 | 5.86 | HTTPS |
| stock-b | 410.1 | 1.31 | HTTPS |
| selected-b | 102.5 | 5.24 | HTTPS |

The three eight-worker runs averaged **81.8 seconds**, versus **367.8 seconds**
for the two stock controls: **4.50x faster** including setup/finalization.
Combined throughput was **6.56 MB/s** for eight workers and **1.46 MB/s** for
stock. The one-worker rfork control was 1.46 MB/s. Even the slowest eight-worker
run was over 3x faster than the fastest stock control. Eight workers are the
selected default; the transfer-phase samples were 6.64–10.70 MB/s. Whole-file
variation includes intermittent MEGA setup delays.

Peak sampled RSS for eight workers was 128.9–130.4 MiB, compared with
111.8–112.7 MiB for stock. Sampled CPU totals were 2.24–2.62 seconds versus
2.29–2.31 seconds for stock (sampling can miss CPU at process exit). Bulk TLS
traffic matched actual file transfer and reached eight simultaneous connections;
there was no existing-file skip or server-side copy. The sweep's original socket
sampler counted TLS bulk connections only, so its megatools HTTP connection
count is unavailable; the TCP byte totals remain valid. The runner now counts
both ports for subsequent runs.

The final stock and eight-worker 512 MiB files both passed independent megatools
full downloads, authentication and SHA-256 checks. The smaller smoke files cover
every candidate worker count. All sweep objects were hard-deleted and remote
absence verified. See [speed.json](speed.json) for raw timings, fingerprints,
samples, checks and cleanup. This sweep used the prototype with explicit worker
flags; the subsequent build changes only the selected default/help and build
wrapper, with its own fingerprint in the 2 GiB report.

The final build uploaded **2 GiB in 250.975 seconds (4m 11s)**:
**8.56 MB/s overall**, **10.26 MB/s sampled transfer throughput**, eight bulk
connections, 132.2 MiB peak sampled RSS and 8.64 sampled CPU seconds. Memory
remained essentially constant as file size quadrupled. Independent full
download/authentication and SHA-256 verification passed; see [large.json](large.json).

For a **projected 10 GiB file**, using the measured 2 GiB whole-file rate for
rfork and the measured megatools reference rate:

| Strategy | Projected completion |
| --- | ---: |
| Start rfork now | 20m 55s |
| Wait 5 minutes, then megatools | 22m 56s |
| Wait 10 minutes, then megatools | 27m 56s |

This is a projection, not a direct 10 GiB test. It conservatively scales the
2 GiB whole-file rate, including setup delay. At these particular rates, the
5/10-minute waiting strategies break even at approximately 16.7/33.5 GiB.
Different routes, servers, setup delays or recovery times can change that
comparison. See [comparison.json](comparison.json) for the arithmetic.

**Decision: keep rfork as a viable experimental uploader.** It removes the
serial bottleneck, passes the >2x repeatability target, and is competitive with
the fast-client reference on this account and route.

## Release limits

This is an experimental standalone fork. M3's bundled binaries and fallback
selection are unchanged. Linux, Windows and Intel macOS amd64 binaries were
built successfully with CGO disabled; [platforms.json](platforms.json) records
their formats and fingerprints. Native unit/race/build/CLI checks passed on
[all three hosted platforms](https://github.com/mega-fork/rfork/actions/runs/39263615737).
Linux CI needed its upstream integration-test executable on PATH and the NFS
mount helper installed; the passing run includes both prerequisites.

On 2026-10-19, native live MEGA validation also passed on
[Windows amd64](https://github.com/mega-fork/rfork/actions/runs/39270418973/job/118125858416)
and [Intel macOS](https://github.com/mega-fork/rfork/actions/runs/39269252510/job/118116918184).
Each platform uploaded a generated 512 MiB payload with 1, 4 and 8 workers,
then downloaded every upload using pristine stock rclone 1.75.2 and compared
SHA-256. Nine empty/AES/chunk-boundary files and two versions of one replacement
file also passed independent download hashes: **14 matching comparisons per OS**.
Replacement left exactly one destination object; ordinary share-link generation
passed. A 512 MiB upload throttled to 1 MiB/s was cancelled by a 12-second hard
context deadline, exited with status 10 after active transfer progress, and left
no completed destination. Each unique remote folder was permanently removed and
its absence verified by a fresh stock-client process. No cloud credentials or
share-link keys are included in the reports.

The first Windows live attempt stopped before MEGA login because the Python
harness used lowercase `nul`, which rclone rejects as a reserved config filename.
The corrected harness uses rclone's portable `notfound` in-memory config sentinel;
the Windows rerun passed. The macOS job in the original run passed independently.
These changes affect CI tools, not the Go uploader implementation. Raw evidence:
[native-live-windows.json](native-live-windows.json) and
[native-live-darwin.json](native-live-darwin.json).

The tested macOS artifact exactly matches the recorded local cross-build.
The tested Windows artifact has SHA-256
`979483bf107b5bf321d7760c267e67d1ae8c6c486dd67d098d914fc760c27f9f`,
which differs from the earlier local Windows cross-build. Use the native-tested
Windows artifact as the shipping candidate; the older cross-build has not itself
been executed. Existing release archives have not been repackaged. Only amd64
was validated; Apple Silicon and Windows ARM64 were not tested. Hosted-runner
transfer timings do not establish throughput on the user's internet connection.

One account and one VPN route do not establish performance for all MEGA
servers or networks. The implementation does not add restart/resume support.
Unknown final commit outcomes require destination inspection before retrying.

All smoke, sweep, 2 GiB and diagnostic remote folders were removed and their
absence verified. Generated local payloads and private credential configurations
were removed. Shareable source/reports were scanned against the private config
values before those configurations were deleted; none were present.
