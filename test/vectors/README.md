# Test vectors

Verbatim copies of published vectors from independent sources. They are vendored
rather than fetched so the suite runs offline and cannot silently change.

| File | Source | Covers |
| --- | --- | --- |
| `bip322-basic.json` | [`bitcoin/bips`](https://github.com/bitcoin/bips/blob/master/bip-0322/basic-test-vectors.json) — `bip-0322/basic-test-vectors.json` | BIP-322 message hashes, `to_spend`/`to_sign` transaction ids, simple-variant signatures for P2WPKH, P2TR and P2WSH multisig, plus eight rejection cases |
| `bip137-bitcoinjs.json` | [`bitcoinjs/bitcoinjs-message`](https://github.com/bitcoinjs/bitcoinjs-message/blob/master/test/fixtures.json) — `test/fixtures.json` | BIP-137 magic hashes and signatures across all four address types (P2PKH compressed and uncompressed, P2SH-P2WPKH, P2WPKH) |
| `xrpl-mainnet.json` | XRP Ledger mainnet, ledger 106442304, fetched from [xrplcluster.com](https://xrplcluster.com/) | 30 signed transactions across both XRPL signing algorithms (secp256k1 and ed25519) and seven transaction types |
| `cip8-go-cip30.json` | [`cardano-foundation/go-cip-30`](https://github.com/cardano-foundation/go-cip-30/blob/main/testdata/fixtures/manifest.json) — `testdata/fixtures/manifest.json` | CIP-8 signatures over enterprise and reward addresses on both networks, embedded and detached payloads, hashed and plain, plus wrong-message and wrong-address rejections |

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

The Cardano fixtures are signed by `cardano-signer` from a fixed, public test
mnemonic, and every expected verdict in them was cross-checked against that same
tool's `verify --cip30` acting as an oracle. Their two negative cases matter more
than the positive ones: the address a CIP-8 signature commits to is chosen by
the signer, so a verifier that reads it without independently binding the key to
the address would accept a proof for somebody else's wallet.
