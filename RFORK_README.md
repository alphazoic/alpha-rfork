# rfork

rfork is an independent fork of **rclone 1.75.2**, focused on concurrent uploads
of native MEGA chunks within a single file. It produces ordinary MEGA files,
with the existing encryption and authentication format. The upstream README,
licenses, module paths and other storage backends are retained.

This is an experimental alpha. See [reports/VALIDATION.md](reports/VALIDATION.md)
for measured performance, verification and release limitations. M3 integration
is a separate step; developing or building this tree does not replace M3's
bundled binaries.

## Using rfork

Existing rclone MEGA configurations work. For example:

```sh
rfork copyto movie.mkv mega:uploads/movie.mkv \
  --transfers 1 --mega-upload-concurrency 8 --mega-use-https=true
```

`--mega-upload-concurrency` defaults to 8, accepts 1–32 and controls simultaneous native chunks
**per file**. `--transfers` controls simultaneous files. Their product determines
the potential number of active chunk requests. Set concurrency to 1 for serial
diagnosis. HTTPS is enabled by default; an explicit configuration setting or
`--mega-use-https=false` can override it.

Each file's worker pool holds at most concurrency+1 chunk buffers, each up to
1 MiB, plus encryption padding, rclone's configured read buffer and ordinary
transport/runtime overhead. Input
is read sequentially, so the worker pool works with rclone's accounting and
bandwidth limiting. Progress can include buffered data; completion requires a
successful final commit.

`--mega-upload-diagnostics` enables an aggregate report per upload attempt. With
`--use-json-log`, the structured report is in `megaUpload`; it contains numeric
settings, source/HTTP-body/acknowledged byte counts, peak requests and stage
timings, without names, URLs or keys. Worker durations overlap, HTTP-body reads
include retries (not TCP/TLS overhead), and acknowledged bytes do not imply a
confirmed file commit. Collection is off by default. Process CPU and peak RSS
remain external measurements, not per-file counters. Timing begins in the
object update, so process startup/login are outside its elapsed measurement.

Workers stop and join on chunk errors or cancellation. A finalization failure
is returned as a non-retryable error with an uncertain remote outcome: inspect
the destination before starting another upload. A server can commit a file
even when its reply is lost. An existing destination is removed only after its
replacement commits successfully. No process-restart upload resume is added.

## Building independently

Move or clone this whole directory, including `deps/go-mega`. No M3 source,
credentials or absolute M3 paths are required. Build scripts require Bash and
an installed Go launcher; Go 1.26.9 and missing modules are downloaded on first
use. Python 3 is used for provenance, lint downloads and packaging; the optional
Linux live benchmark also requires Node.js, `ip`, `ss`, `getconf` and megatools.

```sh
bin/build-rfork linux amd64
bin/build-rfork windows amd64
bin/build-rfork darwin amd64
```

Binaries appear in `build/`. These commands set the rfork name and version;
plain upstream `go build` retains upstream branding defaults. `RFORK_VERSION`
records the upstream base and fork release. Builds use a local dependency
replacement, pinned toolchain, `-mod=readonly`, `-trimpath`, and disabled CGO.
Project caches are contained in `.cache/`; outputs, caches and private benchmark
inputs are excluded from Git.

After building all three targets and committing the reviewed source/reports,
`python3 bin/package-rfork.py` creates binary/source archives, licenses, a
provenance manifest and `SHA256SUMS` under `dist/<version>/`. The manifest
distinguishes validated Linux execution from untested cross-built targets.

To rebuild the unmodified, same-version comparison binary:

```sh
bin/build-stock
```

This fetches the official release archive, checks `UPSTREAM.json`, reconstructs
`build/upstream-source`, and builds `build/rclone-v1.75.2-stock`. The supplied
source was verified byte-for-byte against all 2,621 official release files.

## Tests and lint

```sh
bin/test-rfork
python3 bin/fetch-lint.py
bin/lint-rfork
```

The test script disables configured cloud remotes, runs the upstream unit
suite, races the worker pool and races the patched dependency's real crypto
and HTTP fixtures. Lint checks the touched parent packages and new dependency
changes against the pristine dependency baseline commit. Keep the Git history
when moving the repository; dependency diff lint requires that history, which
is not included in the source tarball. The lint download helper currently
targets Linux amd64. Existing dependency style warnings are excluded.

`.github/workflows/rfork.yml` runs native unit/race and local CLI smoke checks
on Linux, Windows and Intel macOS, and builds artifacts. A cross-built binary
still requires native runtime validation and live MEGA integrity checks before
promotion to a shipping bundle.

## Repeating live checks

For native Windows and Intel macOS checks, add repository Actions secrets
`RFORK_MEGA_EMAIL` and `RFORK_MEGA_PASSWORD` for a dedicated testing account.
Manually run **rfork live MEGA** from the Actions tab. The two platforms run
sequentially. Each builds rfork and a pristine stock 1.75.2 download verifier,
uploads a generated 512 MiB payload with 1/4/8 workers, and compares downloaded
SHA-256 hashes. Additional checks cover empty files, AES/chunk boundaries,
replacement, share-link creation and cancellation of an active upload using a
hard context deadline. This is integrity validation, not a home-connection
speed benchmark. Allow roughly 3.1 GiB of total download quota for both platforms
and at least 1 GiB of free storage. Reports and the native binaries are saved as
Actions artifacts; credentials, raw backend logs and share-link keys are excluded.
Each job permanently deletes only its unique `rfork-ci-*` folder, verifies its
absence with stock rclone, and retries cleanup in a separate always-run step.
Runner loss can prevent cleanup; review the report's folder and cleanup fields.
The workflow is manual-only and does not expose secrets to pull-request jobs.

Use a private rclone configuration with a named MEGA remote and a separate
megatools configuration for the **same account**. Provide at least 8 GiB of
actual free account space. Configurations remain caller-owned: the runner
does not delete them. It creates a unique `rfork-test-*` remote folder, removes
only its own test objects, and records verified cleanup. Reports exclude
passwords and share keys. Review cleanup fields even if a run fails.

```sh
node bin/benchmark-mega.cjs --phase=smoke \
  --config=/private/rclone.conf --remote=benchmark \
  --megatools=/path/to/megatools --megatools-config=/private/megatools.conf
```

Use `--phase=speed` for the 512 MiB sweep and alternating controls, and
`--phase=large --workers=N` for a 2 GiB confirmation. Use the same account,
route and transport for stock/fork comparisons. The runner pins both to HTTPS;
the megatools reference uses its supplied configuration/default transport,
identified by TCP byte counters. Reports record whole-file time, sampled
throughput/resources, transferred TCP bytes, hashes, cancellation and cleanup.
Sampling can miss short-lived sockets and final CPU usage. It does not replace
independent download integrity checks. The benchmark currently targets Linux.

## Fork maintenance

`rfork-upstream-rclone` marks pristine rclone, and `rfork-upstream-deps` adds
the pristine pinned go-mega source. [deps/go-mega/RFORK.md](deps/go-mega/RFORK.md)
documents the local patch. The upstream Go module/import paths intentionally
remain unchanged to keep the fork small. Preserve both upstream licenses in
source and binary distributions. See [RFORK_CHANGELOG.md](RFORK_CHANGELOG.md)
and [PLAN.md](PLAN.md) for scope and validation gates.
