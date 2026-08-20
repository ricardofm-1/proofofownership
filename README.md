# Proof of Ownership

A static web page for signing a message with a crypto wallet and for checking
that a given message was signed by a given address.

It does what Etherscan's "Verified Signatures" tool and Solscan's equivalent do,
minus the publish step — and without a server. There is no backend, no database,
no analytics and nothing is ever stored. The whole thing is HTML, CSS and
JavaScript running in your browser.

Supported today: **Ethereum** (and any EVM address) and **Solana**.

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

**Verify** — paste an address, a message and a signature, press Verify. A valid
result is stated plainly and stamped. An invalid one says *why*, as precisely as
the maths allows:

- a signature of the wrong length or encoding is reported as malformed, with the
  actual byte count;
- a well-formed Ethereum signature that belongs to someone else shows the
  address it *was* signed by, recovered from the signature itself;
- if it fails, and the address might be a smart-contract wallet, you get a note
  saying so rather than a bare "invalid" (see [Limitations](#limitations)).

Input formats are handled leniently: Ethereum signatures with or without `0x`,
in either case, in the 65-byte or the compact 64-byte
[EIP-2098](https://eips.ethereum.org/EIPS/eip-2098) form; addresses in any
checksum casing; Solana signatures in base58 or hex.

Message content, by contrast, is never touched. Whitespace and line breaks are
part of what was signed, so trimming them would change the answer.

## Wallets

| Chain | Wallets |
| --- | --- |
| Ethereum | Any injected wallet found via [EIP-6963](https://eips.ethereum.org/EIPS/eip-6963) (MetaMask, Rabby, Coinbase Wallet, Brave…), plus WalletConnect for mobile |
| Solana | Any wallet implementing the [Wallet Standard](https://github.com/wallet-standard/wallet-standard) (Phantom, Solflare, Backpack…) |

Wallet discovery uses the announcement protocols rather than reading
`window.ethereum`, so having several extensions installed shows you all of them
instead of whichever one won the race to patch the page.

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
2. For local development, copy `.env.example` to `.env` and set
   `VITE_WALLETCONNECT_PROJECT_ID`.
3. For deployment, add the same value as a GitHub Actions secret named
   `VITE_WALLETCONNECT_PROJECT_ID` under **Settings → Secrets and variables →
   Actions**.

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
`https://<user>.github.io/<repo>/`, from a custom domain at the root, and from a
local file. Routing is hash-based, so no server rewrite rules are needed and
deep links survive a refresh.

## How it is put together

Vite and vanilla TypeScript. No framework and a deliberately small dependency
list, because a tool whose whole value is trustworthiness should be small enough
to read:

| Package | Used for |
| --- | --- |
| [`viem`](https://viem.sh) | EIP-191 signing requests and signature recovery |
| [`tweetnacl`](https://tweetnacl.js.org) | ed25519 verification for Solana |
| [`bs58`](https://github.com/cryptocoinjs/bs58) | base58 encoding |
| [`@walletconnect/ethereum-provider`](https://docs.reown.com) | WalletConnect sessions, loaded on demand |

EIP-6963 and Wallet Standard discovery are implemented directly, in about forty
lines each, rather than pulled in as packages.

`package.json` pins `axios` through an `overrides` entry. It arrives several
levels down the WalletConnect dependency tree, and the version resolved by
default carries open advisories; the override keeps `npm audit` clean.

WalletConnect is behind a dynamic import: it is fetched only when someone
actually chooses it, and never on the Verify path. First load is roughly 84 kB.

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
  wallets/      EIP-6963 and Wallet Standard discovery
  lib/          share links, clipboard, DOM helpers
  main.ts       UI wiring
test/           offline verification tests with fixed vectors
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

## Roadmap

- Bitcoin — BIP-137 and [BIP-322](https://github.com/bitcoin/bips/blob/master/bip-0322.mediawiki)
- XRP Ledger
- Cardano — CIP-8 signing over CIP-30 wallets
- EIP-1271 verification as an explicit, opt-in mode that clearly announces the
  RPC call it needs to make
- EIP-712 typed-data signatures

## License

[MIT](LICENSE).
