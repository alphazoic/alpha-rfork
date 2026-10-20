# MEGA upload protocol investigation

Status: local fixtures and live protocol verification passed. The backend batching
pipeline is implemented; native CLI verification remains a separate gate.

The reference SDK groups upload ranges at native chunk boundaries and can retry
prepared transfer requests. Its transfer cache serializes keys, MAC state, upload
tokens and temporary URLs. These are indications of supported mechanisms, not
proof of server behavior or permission to replay a final file-creation request.
References: [transfer request handling](https://github.com/meganz/sdk/blob/master/src/transferslot.cpp)
and [transfer serialization](https://github.com/meganz/sdk/blob/master/src/transfer.cpp).
The moving reference branch was inspected on 2026-10-20; live results remain the
gate for the local implementation.

The dependency accepts complete contiguous native chunks, computes a
separate CTR/MAC result for each, then POSTs one combined ciphertext buffer at the
first offset. It records all constituent MACs only after success. Existing native
uploads delegate to the one-chunk case. The backend exposes request grouping via
`--mega-upload-request-size`; M3 remains unchanged. Fixture checks verify byte-for-byte ciphertext/native-MAC equivalence,
out-of-order requests, unchanged crypto/commit compatibility, retry identity,
failed-batch accounting and argument rejection before input mutation.

The manual `rfork live MEGA` workflow has a `protocol` choice. It uploads a roughly
9 MiB file using 4 MiB request targets and a tiny terminal-response probe, tests an
accepted nonterminal offset replay and a terminal ciphertext replay, commits once
per file, and independently downloads/checks SHA-256 with pristine stock rclone.
If terminal replay is unsupported, the test retains its original handle to verify
and clean up; the report explicitly distinguishes that from successful recovery
of a lost handle. This is a protocol/correctness test, not a speed comparison.

`bin/probe-upload-protocol.py` captures raw test output privately, publishes only
sanitized JSON, and provides cleanup guarded to its unique `rfork-protocol-*`
folder. The workflow always attempts cleanup with fresh stock-client listings
before and after deletion. Process/runner loss can still require receipt-based
cleanup; receipt fields report whether absence was verified. Credentials and
session/crypto state are neither report fields nor artifacts.

## Live result

[Run 39397241665](https://github.com/mega-fork/rfork/actions/runs/39397241665)
tested source `2f644d1262e85d09ccf54d8d609187a50b07e65e`. The roughly 9 MiB
payload with 4 MiB targets passed independent stock download/SHA-256 verification.
Replaying an accepted nonterminal offset succeeded. Replaying the terminal
ciphertext returned a handle that successfully committed and passed a second
independent download/SHA-256 check. Scoped cleanup was verified. The sanitized
receipt is `upload-protocol-39397241665.json`.

This establishes the tested endpoint/account behavior, not session lifetime or
durable restart-resume correctness. Body-error replay remains opt-in and final
file commits are never blindly retried.
