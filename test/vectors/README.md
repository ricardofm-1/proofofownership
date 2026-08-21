# Test vectors

Verbatim copies of published vectors from independent sources. They are vendored
rather than fetched so the suite runs offline and cannot silently change.

| File | Source | Covers |
| --- | --- | --- |
| `bip322-basic.json` | [`bitcoin/bips`](https://github.com/bitcoin/bips/blob/master/bip-0322/basic-test-vectors.json) — `bip-0322/basic-test-vectors.json` | BIP-322 message hashes, `to_spend`/`to_sign` transaction ids, simple-variant signatures for P2WPKH, P2TR and P2WSH multisig, plus eight rejection cases |
| `bip137-bitcoinjs.json` | [`bitcoinjs/bitcoinjs-message`](https://github.com/bitcoinjs/bitcoinjs-message/blob/master/test/fixtures.json) — `test/fixtures.json` | BIP-137 magic hashes and signatures across all four address types (P2PKH compressed and uncompressed, P2SH-P2WPKH, P2WPKH) |
| `xrpl-mainnet.json` | XRP Ledger mainnet, ledger 106442304, fetched from [xrplcluster.com](https://xrplcluster.com/) | 30 signed transactions across both XRPL signing algorithms (secp256k1 and ed25519) and seven transaction types |

Using someone else's vectors is the point: a round trip against our own signing
code would pass even if the implementation were wrong in a self-consistent way.

The XRPL vectors take that a step further. Rather than being published as
fixtures, they are transactions that were accepted into a validated ledger,
which means XRPL consensus had already ruled every one of those signatures good
before they were recorded. All 178 single-signed transactions in the ledger were
checked and every one verified; the file keeps a spread of them. Notably, the
signed transactions in `xrpl.js`'s own codec fixtures do **not** all carry real
signatures — several newer ones are hand-authored with placeholder values — so
they are unusable for this purpose despite looking like the obvious choice.
