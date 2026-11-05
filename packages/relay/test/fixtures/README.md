`0.17.32-first-frames.json` replays schema-2 discovery, the released secure handshake,
and the first sync/hub frames from commit
`77bf1c448d6ce883b844443204c7c9c7306d0c4c` (`v0.17.32`). The `sources` entries are
SHA-256 digests of the unchanged release sources. All keys and process identities
are synthetic fixture values.

The handshake/frame vectors were produced with that commit's `SecureSession`,
using client nonce `01` repeated 16 times and relay nonce `02` repeated 16 times,
key `fixture-key`, and room `local/baseline`. Client plaintexts are an empty
sync step 1 (`00 00 00`) and type-7 JSON containing the exact `hello` object in
property order as stored. Relay plaintext is an empty sync step 1. Neither
negotiation constants nor a current-client protocol variant produce these vectors.

This is a bounded discovery/first-frame replay regression, not a replacement for
the archived executable old/new process matrix or real-host release acceptance.
