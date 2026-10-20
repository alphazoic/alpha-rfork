# Durable upload resume validation

The explicit local-file command, encrypted account-bound checkpoints, native
protected store, source fingerprints, coalesced writer, pending-only accounting
and irreversible commit state are implemented. M3 and saved release tags are
unchanged. These are correctness results, not a worker/settings speed ranking.

## Source and validation boundaries

- `a032839`: integrated command and local TLS process/fault fixtures. Full native
  upstream suites, dependency/backend/storage races, lint, builds and CLI smoke
  passed on Linux, Windows and macOS in run `39436148540`.
- `39ee917`: adds pending-only hard/soft/cautious transfer-budget admission. Final
  focused native backend/dependency/store/accounting races, lint, builds and CLI
  smoke passed on all three platforms in `39437206355`.
- Live runs below compile that upload implementation with subsequent documentation
  and runner changes. Each tested binary matches the corresponding `39ee917`
  native binary hash. Sources are recorded in the individual receipts.
- `8de3a30`: the only later production Go change wraps explicit stops with both
  no-retry markers. This prevents the CLI's transient-cause classifier from turning
  an uncertain commit into retry exit 5. A regression first reproduced the bug;
  the fixed native TLS fixture commits at the fake provider, loses the body as an
  actual `unexpected EOF`, restarts, refuses replay and checks both retry layers.
  Native validation/build run `39442759187` passed on all three platforms. Upload
  data, crypto, source verification, checkpoint persistence and successful commit
  behavior are unchanged by this final error-classification delta. Do not describe
  the earlier live receipts as exact-binary live tests of that delta.

## Integrated live results

| Native platform | Run | Recorded checks | Independent stock SHA-256 checks | Fresh authentication before resume | Scoped cleanup |
| --- | --- | ---: | ---: | --- | --- |
| Linux amd64 | `39440121324` | 45 | 6 matched | passed | verified |
| Windows amd64 | `39440941355` | 34 | 5 matched | passed | verified |
| macOS amd64 | `39441287938` | 45 | 6 matched | passed | verified |

Payload: exactly 9,437,215 bytes (9 MiB + 31); two workers, a 1 MiB request limit,
10ms data pacing and 50ms checkpoint coalescing. A temporary 2 MiB/s cap creates
an interruption window; resumed completion is uncapped. Timings include CLI
startup/authentication where applicable and are not throughput comparisons.

The gates use actual CLI subprocesses and encrypted on-disk state. They verify:

- SIGINT on Linux/macOS and abrupt process death on every platform, with no
  published file before restart; saved acknowledgements authenticate and skip
  bytes on the original session after restart.
- Fresh password authentication before a restart, while routine commands reuse a
  private temporary login config. Keys/configs/checkpoints never enter artifacts.
- Wrong destination binding rejected; changed content rejected even when size and
  mtime are preserved; restoring the original source can finish its session.
- Repeating a completed checkpoint yields the exact committed node identity and
  zero data reads; a new checkpoint refuses an existing name. Identity checks are
  separate from stock SHA-256 counts in the table.
- Empty files, a 17-byte file and a 131,073-byte boundary file, each verified with
  pristine stock rclone, plus complete scoped cleanup.

Saved progress varied with interruption timing. Positive restored byte counts
ranged from 524,288 to 1,966,080 across these cases; this demonstrates recovery,
not a guaranteed retransmission budget. Current-attempt statistics matched only
pending bytes while full-source reads remained complete.

## Artifacts and remaining limits

The hash-verified live binaries and receipts are retained under ignored
`build/validated-39440121324/`, `build/validated-39440941355/` and
`build/validated-39441287938/`. `upload-resume-native-binaries-39437206355.json`
records their matching native hashes. Final classification-fix artifacts are saved separately under
`build/validated-native-39442759187/`; individual hashes, verified archive digests
and source are recorded in `upload-resume-native-binaries-39442759187.json`.
`upload-resume-final-manifest.json` joins the final artifacts with their exact
native and preceding live-proof provenance. The local Linux build matches the
final Linux native hash exactly.

Short interruptions establish the tested provider behavior, not general session
lifetime, IP migration or guaranteed physical power-loss behavior. Expired or
restart-required sessions retain state and require inspection. Native fixtures
establish storage barriers, fault handling, OS permissions/ownership and process
exclusion; hardware failure is not simulated.

The previous account reported blocked before cases in `39418890708`; its cleanup
also failed. Replacement-account read-only access passed in `39438939305` after
the user replaced the secrets. The earlier folder
`rfork-protocol-8097f0bbab2147e28329abfe5e0215d6` remains unverified on the prior
account; absence from a different account would not prove cleanup. All new live
folders above were verified removed on the usable account.

No release tag or M3 binary/settings change is included. The saved alpha remains
available for rollback. The later M3 settings/adapter contract is documented in
`../M3_INTEGRATION.md`.
