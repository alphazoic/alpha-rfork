# Local go-mega patch

Based on upstream `github.com/t3rm1n4l/go-mega` revision
`c6acd6a5bd04` (`v0.0.0-20260717075258-c6acd6a5bd04`). The original license is
retained in LICENSE. The parent module selects this copy with a local replace.

Added APIs: `NewUploadContext`, `UploadChunkContext` and `FinishContext`.
The existing APIs remain wrappers. Changes provide per-upload HTTP contexts,
cancellable API-lock/backoff/hashcash waits, joined hashcash workers, explicit
per-upload HTTPS selection, and guarded commit handling. Finalization requires
all chunk MACs and a completion handle, executes once, and does not replay an
API request after a lost response. Chunk retries reuse the same ciphertext.
Negative MEGA chunk responses are errors. Non-200 API responses cannot become
nil-error successes.

`EnableDiagnostics` enables bounded per-upload numeric aggregates before workers
start; `Diagnostics` returns a concurrency-safe snapshot. No names, URLs, keys or
completion handles are included. HTTP body reads include retry payloads and are
distinct from acknowledged chunks and final file creation.

`SetUploadRetryOptions` sets a per-file additional-attempt budget and opt-in
response-body replay before workers start. Data requests classify transient and
permanent HTTP/provider errors, cap response bodies, respect Retry-After and use
cancellable jittered backoff. Encryption happens once. `UploadRequestError`
preserves causes for inspection without printing upload URLs. Body replay remains
opt-in for compatibility; a small live check recovered a usable terminal handle
from a ciphertext replay. Final-commit protection
is unchanged. None of these per-upload options mutates the shared account client.

`SetUploadRequestHook` installs per-file admission before workers start. Every
data attempt, including a retry, invokes the context-aware hook. A returned
release callback runs after body close or on request/transport failure. The
backend uses this for separate data pacing and foreground connection admission;
the dependency's retry backoff remains independent. Diagnostics include hook wait
time in `pacing`.

`ChunkRangeLocation` and experimental `UploadRangeContext` group contiguous
native chunks into one request without changing per-chunk CTR/MAC boundaries.
Failed requests record none of their constituent MACs; retries reuse the full
ciphertext. Native single-chunk uploads use the same preparation path. These APIs
are covered by native crypto equivalence and failure fixtures. A manual live gate
verified batching, accepted-offset replay, terminal-handle recovery, independent
stock-client SHA-256 checks and cleanup. The backend now supports configurable
bounded request jobs; its native CLI verification is a separate gate.

Empty files retain a zero aggregate MAC: their empty POST obtains the upload
handle but contributes no data chunk to the authentication fold. This fixes
upstream empty uploads rejected by independent clients with a MAC mismatch.

Regression tests in upload_context_test.go cover real concurrent native chunk
encryption, independent decryption/MAC verification, commit responses, lost
commit replies, cancellation, retry identity and transport isolation.

The original encryption format and key-generation algorithm are unchanged.
The library's existing download/session behavior remains part of the upstream
base. Credentials are required only for its explicitly skipped live tests.
