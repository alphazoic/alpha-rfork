# MEGA upload protocol investigation

Status: local fixture validation complete; live verification pending.

The reference SDK groups upload ranges at native chunk boundaries and can retry
prepared transfer requests. Its transfer cache serializes keys, MAC state, upload
tokens and temporary URLs. These are indications of supported mechanisms, not
proof of server behavior or permission to replay a final file-creation request.
References: [transfer request handling](https://github.com/meganz/sdk/blob/master/src/transferslot.cpp)
and [transfer serialization](https://github.com/meganz/sdk/blob/master/src/transfer.cpp).
The moving reference branch was inspected on 2026-10-20; live results remain the
gate for the local implementation.

The dependency prototype accepts complete contiguous native chunks, computes a
separate CTR/MAC result for each, then POSTs one combined ciphertext buffer at the
first offset. It records all constituent MACs only after success. Existing native
uploads delegate to the one-chunk case. It is not yet wired to a batching CLI flag
or M3. Fixture checks verify byte-for-byte ciphertext/native-MAC equivalence,
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
