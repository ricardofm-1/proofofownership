# Test vectors

Verbatim copies of published vectors from independent sources. They are vendored
rather than fetched so the suite runs offline and cannot silently change.

| File | Source | Covers |
| --- | --- | --- |
| `bip322-basic.json` | [`bitcoin/bips`](https://github.com/bitcoin/bips/blob/master/bip-0322/basic-test-vectors.json) — `bip-0322/basic-test-vectors.json` | BIP-322 message hashes, `to_spend`/`to_sign` transaction ids, simple-variant signatures for P2WPKH, P2TR and P2WSH multisig, plus eight rejection cases |
| `bip137-bitcoinjs.json` | [`bitcoinjs/bitcoinjs-message`](https://github.com/bitcoinjs/bitcoinjs-message/blob/master/test/fixtures.json) — `test/fixtures.json` | BIP-137 magic hashes and signatures across all four address types (P2PKH compressed and uncompressed, P2SH-P2WPKH, P2WPKH) |

Using someone else's vectors is the point: a round trip against our own signing
code would pass even if the implementation were wrong in a self-consistent way.
