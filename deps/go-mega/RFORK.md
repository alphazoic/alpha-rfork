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
opt-in until live terminal-response behavior is validated; final-commit protection
is unchanged. None of these per-upload options mutates the shared account client.

Empty files retain a zero aggregate MAC: their empty POST obtains the upload
handle but contributes no data chunk to the authentication fold. This fixes
upstream empty uploads rejected by independent clients with a MAC mismatch.

Regression tests in upload_context_test.go cover real concurrent native chunk
encryption, independent decryption/MAC verification, commit responses, lost
commit replies, cancellation, retry identity and transport isolation.

The original encryption format and key-generation algorithm are unchanged.
The library's existing download/session behavior remains part of the upstream
base. Credentials are required only for its explicitly skipped live tests.
