# Proof of Ownership

A static web page for **signing a message with a crypto wallet** and for
**verifying** that a given message was signed by a given address — Bitcoin,
Ethereum, Solana, Ripple (XRP Ledger) and Cardano.

Live at
[https://www.proofofownership.tech](https://www.proofofownership.tech).

It does what Etherscan's "Verified Signatures" tool and Solscan's equivalent do,
minus the publish step — and without a server. There is no backend, no database,
no analytics and nothing is ever stored. The whole thing is HTML, CSS and
JavaScript running in your browser.

## Why it is safe

Three claims, and what backs each of them up:

**Your private key never leaves your wallet.** Signing is done by the wallet
itself. This page sends it a message and receives a signature back; it never
sees, asks for, or has any use for a key or seed phrase.

**Verification never touches the network.** Checking a signature is pure
arithmetic over the address, the message and the signature. No wallet
connection, no RPC endpoint, no API. You can disconnect from the internet, or
save the page to disk and open it from `file://`, and verification still works.
Open your browser's network tab and watch: pressing **Verify** produces no
requests.

**Nothing is stored, because there is nowhere to store it.** The site is static
files on GitHub Pages. Shareable links carry the proof in the URL *fragment*
(the part after `#`), which browsers never transmit to a server — so even the
act of sharing a proof reveals nothing to the host.

Signing a message is also free and off-chain. It is not a transaction, it costs
no gas, and it never touches a blockchain. The network your wallet happens to be
on is irrelevant, which is why this tool never asks you to switch networks.

## What it does

**Sign** — connect a wallet, type a message, sign it. You get the address, the
message and the signature as three separately copyable fields, plus:

- **Copy all as JSON** — `{ "chain", "address", "message", "signature" }`
- **Copy shareable link** — a URL that opens the Verify tab pre-filled and
  checks the signature immediately. This is the no-storage replacement for
  Etherscan's "publish": the link *is* the proof.
- **Download PDF** — a one-page (or more, if the signature is long) certificate
  of the signed message, drawn in the site's light palette. Built in the
  browser with [`pdf-lib`](https://pdf-lib.js.org); nothing is uploaded.

**Verify** — paste an address, a message and a signature, press Verify. A valid
result is stated plainly and stamped, and can be downloaded as the same PDF.
An invalid one says *why*, as precisely as the maths allows:

- a signature of the wrong length or encoding is reported as malformed, with the
  actual byte count;
- a well-formed signature that belongs to someone else shows the address it
  *was* signed by, wherever the chain allows that to be worked out;
- if it fails, and the address might be a smart-contract wallet, you get a note
  saying so rather than a bare "invalid" (see [Limitations](#limitations));
- and where the answer genuinely cannot be computed here — a BIP-322 signature
  over a multisig script, say — the result says *cannot be checked* rather than
  *invalid*, because those are not the same claim.

Input formats are handled leniently: Ethereum signatures with or without `0x`,
in either case, in the 65-byte or the compact 64-byte
[EIP-2098](https://eips.ethereum.org/EIPS/eip-2098) form; addresses in any
checksum casing; Solana signatures in base58 or hex; Bitcoin signatures in
either signing standard, detected automatically; XRP Ledger transactions as hex
in any case, and addresses in classic `r…` or tagged `X…` form; Cardano
signatures as the wallet's own JSON object or as two bare hex strings.

Message content, by contrast, is never touched. Whitespace and line breaks are
part of what was signed, so trimming them would change the answer.

## Wallets

| Chain | Wallets |
| --- | --- |
| Ethereum | Any injected wallet found via [EIP-6963](https://eips.ethereum.org/EIPS/eip-6963) (MetaMask, Rabby, Coinbase Wallet, Brave…), plus WalletConnect for mobile |
| Solana | Any wallet implementing the [Wallet Standard](https://github.com/wallet-standard/wallet-standard) (Phantom, Solflare, Backpack…) |
| Bitcoin | Any wallet implementing the [Bitcoin Wallet Standard](https://github.com/ExodusMovement/bitcoin-wallet-standard) (Phantom, Magic Eden, Leather, recent OKX…), plus UniSat and older OKX builds via their injected provider |
| XRP Ledger | Crossmark. Any other XRPL wallet works through the Verify tab — see [below](#the-xrp-ledger-has-no-message-signing-standard) |
| Cardano | Any wallet implementing [CIP-30](https://cips.cardano.org/cip/CIP-30) (Lace, Eternl, Nami, Typhon, Vespr, Flint…) |

Wallet discovery uses the announcement protocols rather than reading
`window.ethereum`, so having several extensions installed shows you all of them
instead of whichever one won the race to patch the page.

Bitcoin is discovered twice over, because the ecosystem is mid-migration.
Wallet Standard is the current route and is tried first; Phantom has already
deprecated its injected `window.phantom.bitcoin` provider. UniSat and older OKX
builds still only expose a global, so those are probed as a fallback. A wallet
found both ways is listed once, under its Wallet Standard entry.

Bitcoin wallets often expose more than one account — Phantom separates a payment
address from an ordinals one. The payment address is chosen for signing, since
that is the one people mean by "my Bitcoin address".

## Bitcoin has two signing standards

Ethereum and Solana each have one way to sign a message. Bitcoin has two, and
which one applies depends on the address:

- **[BIP-137](https://github.com/bitcoin/bips/blob/master/bip-0137.mediawiki)**,
  the legacy "Bitcoin Signed Message" format produced by Bitcoin Core's
  `signmessage`, Electrum and most hardware wallets. A 65-byte recoverable ECDSA
  signature over the magic-prefixed message. The public key is recovered from
  the signature, so verifying needs nothing but the address.
- **[BIP-322](https://github.com/bitcoin/bips/blob/master/bip-0322.mediawiki)**,
  finalised as 1.0.0 in April 2026 and what modern browser wallets emit. Rather
  than hashing the message, it builds two virtual transactions — a `to_spend`
  that commits to the message and a `to_sign` that spends it — and the signature
  is the witness stack satisfying them. Neither transaction can be broadcast:
  `to_spend` spends an output that cannot exist.

You do not have to know which you have. Both arrive base64-encoded, and the two
are told apart by length and by the `smp`/`ful`/`pof` prefix that BIP-322 1.0.0
introduced. Signing picks the standard your address can actually be verified
under — BIP-137 for `1…` and `3…`, BIP-322 for `bc1…`.

Coverage is BIP-137 for all four address types, and BIP-322 *simple* for P2WPKH
and key-path taproot. The *full* and *proof-of-funds* variants, and simple
signatures over scripted addresses such as multisig, need a complete Bitcoin
script interpreter; those report **cannot be checked** instead of a verdict. The
BIP itself defines this "inconclusive" outcome for validators without an
interpreter, and it is the honest answer — such a signature may well be valid.

## The XRP Ledger has no message-signing standard

Ethereum has EIP-191, Bitcoin has BIP-137 and BIP-322, Solana signs raw bytes.
The XRP Ledger has nothing equivalent, and the schemes in the wild genuinely
disagree: Ripple's own wallet service documents a `\x19XRP Ledger Signed
Message:` prefix hashed with **keccak256**, GemWallet's `signMessage` documents
its return value but never says what preimage goes under the signature, and
Xaman signs a `SignIn` pseudo-transaction instead of any plaintext at all.
Guessing between them would mean shipping a verifier that could call a genuine
proof invalid.

What *is* specified exactly, and is what every XRPL key already does, is
transaction signing. So a proof here is an ordinary signed transaction carrying
the message in a memo — the same manoeuvre BIP-322 makes on Bitcoin, and for the
same reason. Verifying one is arithmetic: parse the transaction, drop the
signature fields, prepend rippled's `STX\0` prefix, and check the signature over
the result. Both XRPL signing algorithms are supported, secp256k1 and ed25519.

This also explains why the signature field wants a whole transaction rather than
64 bytes. An XRPL address is a hash of a public key, and neither signature type
can be reversed to recover it — ed25519 is not recoverable at all, and XRPL's
secp256k1 signatures are DER-encoded rather than the recoverable form Ethereum
and BIP-137 use. The public key has to be published somewhere, and inside the
signed transaction is exactly where the protocol already puts it.

The transaction this tool asks a wallet to sign is an `AccountSet` that changes
no settings, built so it cannot be broadcast even by someone who intercepts it:
its fee of zero is below the network minimum, and a `LastLedgerSequence` of zero
expired before any ledger that could have included it. Two independent reasons,
so a wallet that helpfully rewrites one of them still cannot turn a proof into a
live transaction.

Two situations get **cannot be checked** rather than a verdict, both because
settling them needs the ledger and verification here is offline by design. A
multi-signed transaction is authorised by a quorum listed in the account's
signer list; and XRPL lets an account delegate signing to a *regular key*, so a
valid signature from a key that does not hash to the account may be perfectly
legitimate or may be someone else's entirely. Only the ledger knows which.

## Cardano signs a COSE structure, and names its own address

Cardano has a real standard —
[CIP-8](https://cips.cardano.org/cip/CIP-0008) message signing, reached through
[CIP-30](https://cips.cardano.org/cip/CIP-30) wallets — but its shape differs
from the others in two ways worth knowing.

First, the signature does not cover the message directly. It covers a COSE
`Sig_structure`: a CBOR array holding the string `Signature1`, the protected
headers, an empty external-data field, and the payload. Verifying means
rebuilding those bytes exactly, reusing the protected headers verbatim rather
than re-encoding them, since a re-encoding differing by a single byte would
compute a different signature over identical-looking data. The payload itself
may be embedded or *detached*, and may be the message or its BLAKE2b-224 hash;
all four combinations occur and all four are handled.

Second, a wallet returns *two* values, `signature` and `key`, and both are
needed. A Cardano address is a hash of its key, so the key cannot be recovered
from a signature the way Ethereum's can. Paste the CIP-30 object exactly as the
wallet gave it — `{ "signature": "84…", "key": "a4…" }` — or the two hex strings
separated by a space.

The subtle part is who the signature says you are. CIP-8 puts the signer's
address in the protected headers, so it *is* signed and cannot be altered
afterwards — but the signer chose it, which is not the same as it being true.
Reading it at face value would let anyone sign a message naming your address and
have it accepted. So the address is never trusted on its own: the public key is
hashed and that hash must appear among the address's own credentials. Both of
the rejection cases in the test fixtures exist for exactly this reason.

Script addresses report **cannot be checked**. They are controlled by a script
the ledger evaluates rather than by a key, so no single-key signature could
prove control of one — and Byron-era addresses predate CIP-8 entirely.

## Running it locally

```bash
npm install
npm run dev
```

Then open the URL it prints. Other scripts:

```bash
npm test        # signature verification tests, offline, no browser needed
npm run build   # type-check and produce dist/
npm run preview # serve the production build
```

Requires Node 22.18 or newer (the test suite runs TypeScript directly through
Node's built-in type stripping).

## WalletConnect setup

WalletConnect is optional. Without a project ID the site builds and runs
normally, and WalletConnect simply appears in the wallet list as unavailable —
MetaMask, Phantom and all verification are unaffected.

To enable it:

1. Create a free project at [cloud.reown.com](https://cloud.reown.com) and copy
   the project ID.
2. Under the project's **Allowed domains**, add:
   - `https://www.proofofownership.tech`
   - `https://proofofownership.tech`
   (`localhost` is allowed automatically.)
3. For local development, copy `.env.example` to `.env` and set
   `VITE_WALLETCONNECT_PROJECT_ID`.
4. For deployment, add the same value as a GitHub Actions secret named
   `VITE_WALLETCONNECT_PROJECT_ID` under **Settings → Secrets and variables →
   Actions**, then re-run the **Deploy to GitHub Pages** workflow so the live
   site is built with the ID.

The ID is a public client identifier, not a secret in the cryptographic sense —
it ends up in the built JavaScript, as it does for every WalletConnect site.
It is kept in an environment variable so it stays out of version control and can
be rotated or scoped to your own domain.

## Deploying to GitHub Pages

1. Push the repository to GitHub.
2. Go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Push to `main`.

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) installs
dependencies, runs the verification tests, builds, and publishes `dist/`. A
failing test blocks the deploy, on the principle that a broken verifier is worse
than a stale one.

The build uses relative asset paths, so the same artifact works from
`https://www.proofofownership.tech`, from `https://<user>.github.io/<repo>/`,
and from a local file. Routing is hash-based, so no server rewrite rules are
needed and deep links survive a refresh.

### Custom domain (Namecheap)

The live hostname is `www.proofofownership.tech`. GitHub Pages is told that in
[`public/CNAME`](public/CNAME). At Namecheap, under **Domain List → Manage →
Advanced DNS**, the host records should be:

| Type | Host | Value | TTL |
| --- | --- | --- | --- |
| A Record | `@` | `185.199.108.153` | Automatic |
| A Record | `@` | `185.199.109.153` | Automatic |
| A Record | `@` | `185.199.110.153` | Automatic |
| A Record | `@` | `185.199.111.153` | Automatic |
| CNAME Record | `www` | `ricardofm-1.github.io.` | Automatic |

Delete any parking, URL-redirect, or leftover A/CNAME records for `@` or `www`
first — they conflict. Nameservers should stay on **Namecheap BasicDNS**.

After DNS answers (often under an hour, sometimes longer), GitHub issues a TLS
certificate. Turn on **Settings → Pages → Enforce HTTPS** once it is ready.

## How it is put together

Vite and vanilla TypeScript. No framework and a deliberately small dependency
list, because a tool whose whole value is trustworthiness should be small enough
to read:

| Package | Used for |
| --- | --- |
| [`viem`](https://viem.sh) | EIP-191 signing requests and signature recovery |
| [`tweetnacl`](https://tweetnacl.js.org) | ed25519 verification for Solana |
| [`bs58`](https://github.com/cryptocoinjs/bs58) | base58 encoding |
| [`@noble/curves`](https://github.com/paulmillr/noble-curves) | secp256k1 key recovery and Schnorr verification for Bitcoin, secp256k1 and ed25519 verification for the XRP Ledger and Cardano |
| [`@noble/hashes`](https://github.com/paulmillr/noble-hashes) | SHA-256, SHA-512, RIPEMD-160 and BLAKE2b |
| [`@scure/base`](https://github.com/paulmillr/scure-base) | base58check, bech32, bech32m and Ripple's base58 alphabet |
| [`@walletconnect/ethereum-provider`](https://docs.reown.com) | WalletConnect sessions, loaded on demand |
| [`pdf-lib`](https://pdf-lib.js.org) | Proof PDFs, loaded on demand |
| [`uqr`](https://github.com/unjs/uqr) | Donation-address QR codes, loaded on demand |

EIP-6963, Wallet Standard and CIP-30 discovery are implemented directly, in
about forty lines each, rather than pulled in as packages. So are Bitcoin's
transaction serialisation and the BIP-143 and BIP-341 sighash algorithms, the
XRPL binary format, and the slice of CBOR that COSE needs — which is why none of
`bitcoinjs-lib`, `xrpl` or a CBOR library appears in that table. Only the subset
each proof needs is required, and it is short enough to read in one sitting. The
CBOR reader in particular accepts definite-length values only and errors on
anything else, which is the behaviour you want from a verifier.

`package.json` pins `axios` through an `overrides` entry. It arrives several
levels down the WalletConnect dependency tree, and the version resolved by
default carries open advisories; the override keeps `npm audit` clean.

WalletConnect is behind a dynamic import: it is fetched only when someone
actually chooses it, and never on the Verify path. The PDF library is the same
idea: it is loaded only when **Download PDF** is pressed. First load is roughly
84 kB.

### Adding a chain

Chain logic sits behind one interface in
[`src/chains/types.ts`](src/chains/types.ts):

```ts
interface ChainAdapter {
  id: ChainId;
  name: string;
  listWallets(): Promise<WalletOption[]>;
  connect(walletId: string): Promise<Connection>;
  verify(input: VerifyInput): Promise<VerifyOutcome>;
}
```

A new chain is a new module satisfying that interface plus one line in
[`src/chains/index.ts`](src/chains/index.ts). The UI reads labels, placeholders
and format hints off the adapter, so it needs no changes.

```
src/
  chains/       adapters — the only chain-aware code
    bitcoin/    address encoding, BIP-137, BIP-322, wallet shims
    xrpl/       address encoding, binary transaction reader, proof checking
    cardano/    address encoding, COSE_Sign1, CIP-30 wallets
  wallets/      EIP-6963 and Wallet Standard discovery
  lib/          share links, clipboard, byte and DOM helpers
  main.ts       UI wiring
test/           offline verification tests
  vectors/      published vectors, vendored — see the README there
```

## Limitations

**Smart-contract wallets are not supported yet.** Safe, Argent, Coinbase Smart
Wallet and similar sign via [EIP-1271](https://eips.ethereum.org/EIPS/eip-1271),
which is validated by calling a method on the wallet's contract. That needs an
RPC endpoint, which would break the promise that verification is offline. Rather
than quietly calling such signatures invalid, the tool flags the possibility
whenever an Ethereum check fails.

**Ethereum only covers `personal_sign`.** EIP-712 typed-data signatures are a
different scheme and are not handled.

**Bitcoin scripted addresses cannot be decided here.** Multisig and script-path
taproot signatures need a full script interpreter; they are reported as
*cannot be checked* rather than judged. Same for BIP-322's `ful` and `pof`
variants.

**XRPL regular keys and multi-signing cannot be decided here.** Both are settled
by state that only the ledger holds, so both report *cannot be checked*. Signing
is currently wired up for Crossmark alone; every other XRPL wallet still works
through the Verify tab, since any signed transaction carrying the message in a
memo is a valid proof regardless of what produced it.

**Cardano script and Byron addresses cannot be decided here.** A script address
is controlled by ledger-evaluated code rather than a key, and Byron addresses
predate CIP-8; both report *cannot be checked*.

## Roadmap

- BIP-322 `full` variant and a script interpreter for multisig addresses
- GemWallet and Xaman signing for the XRP Ledger
- Cosmos — ADR-036 signing
- EIP-1271 verification as an explicit, opt-in mode that clearly announces the
  RPC call it needs to make
- EIP-712 typed-data signatures

## License

[MIT](LICENSE).
