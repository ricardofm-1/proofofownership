/**
 * Minimal Wallet Standard registry (the multi-chain equivalent of EIP-6963).
 *
 * The official `@wallet-standard/app` package does exactly this, but the
 * protocol is ~40 lines of event plumbing and this is a trust-sensitive tool,
 * so we keep the dependency out and the mechanism visible. Phantom, Solflare
 * and Backpack all register through it, which means one code path covers them.
 *
 * The same registry serves Solana and Bitcoin: a wallet announces itself once
 * and advertises a feature per chain.
 */

export interface WalletAccount {
  /** Base58 public key on Solana; the address string on Bitcoin. */
  address: string;
  publicKey: Uint8Array;
  chains: readonly string[];
  features: readonly string[];
  /** Non-standard, but Phantom uses it to separate payment from ordinals. */
  purpose?: string;
}

interface ConnectFeature {
  connect(input?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccount[] }>;
}

/**
 * Bitcoin has its own connect feature rather than reusing `standard:connect`,
 * because it needs the app to say which address types it wants. MetaMask
 * implements only this one, with no `standard:connect` at all.
 */
export interface BitcoinConnectFeature {
  connect(input: {
    purposes: ('payment' | 'ordinals')[];
  }): Promise<{ accounts: readonly WalletAccount[] }>;
}

interface DisconnectFeature {
  disconnect(): Promise<void>;
}

interface SignMessageFeature {
  signMessage(
    ...inputs: { account: WalletAccount; message: Uint8Array }[]
  ): Promise<{ signedMessage: Uint8Array; signature: Uint8Array }[]>;
}

/**
 * `bitcoin:signMessage` takes a single input rather than Solana's variadic
 * form, and implementations disagree on whether the result is wrapped in an
 * array and whether the signature is bytes or an encoded string.
 */
export interface BitcoinSignMessageFeature {
  signMessage(input: { account: WalletAccount; message: Uint8Array | string }): Promise<
    | { signature: Uint8Array | string }
    | { signature: Uint8Array | string }[]
  >;
}

export interface StandardWallet {
  version: string;
  name: string;
  icon: string;
  chains: readonly string[];
  features: Record<string, unknown> & {
    'standard:connect'?: ConnectFeature;
    'standard:disconnect'?: DisconnectFeature;
    'solana:signMessage'?: SignMessageFeature;
    'bitcoin:connect'?: BitcoinConnectFeature;
    'bitcoin:disconnect'?: DisconnectFeature;
    'bitcoin:signMessage'?: BitcoinSignMessageFeature;
  };
  accounts: readonly WalletAccount[];
}

/** The object wallets receive so they can hand us their implementation. */
interface WalletStandardApi {
  register(...wallets: StandardWallet[]): () => void;
  get(): readonly StandardWallet[];
  on(event: string, listener: (...args: never[]) => void): () => void;
}

/**
 * Keyed by object identity, not by name. Multi-chain wallets register one
 * object per chain under the same name — Phantom announces a Solana wallet and
 * a Bitcoin wallet, both called "Phantom" — so keying by name would silently
 * drop every chain but the last one to register.
 */
const registry = new Set<StandardWallet>();
let listening = false;

function register(...wallets: StandardWallet[]): () => void {
  for (const wallet of wallets) {
    if (wallet?.name) registry.add(wallet);
  }
  return () => {
    for (const wallet of wallets) registry.delete(wallet);
  };
}

const api: WalletStandardApi = {
  register,
  get: () => [...registry],
  on: () => () => {},
};

function startListening(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;

  // Wallets that load after us announce themselves with `register-wallet`,
  // passing a callback that expects our registry API.
  window.addEventListener('wallet-standard:register-wallet', (event) => {
    const callback = (event as CustomEvent<(api: WalletStandardApi) => void>).detail;
    if (typeof callback === 'function') callback(api);
  });
}

/** Prompts every wallet to announce itself, then returns the full registry. */
async function discoverAll(waitMs: number): Promise<StandardWallet[]> {
  if (typeof window === 'undefined') return [];
  startListening();

  // Wallets that loaded before us are idling until they see `app-ready`.
  window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
  await new Promise((resolve) => setTimeout(resolve, waitMs));

  return [...registry];
}

/**
 * A wallet is usable if it offers any connect feature. Bitcoin wallets may
 * implement `bitcoin:connect` instead of `standard:connect` — MetaMask ships
 * only the former — so requiring the standard one would hide them.
 */
const canConnect = (wallet: StandardWallet): boolean =>
  typeof wallet.features['standard:connect']?.connect === 'function' ||
  typeof wallet.features['bitcoin:connect']?.connect === 'function';

function hasFeature(wallet: StandardWallet, feature: SignMessageFeatureName): boolean {
  const entry = wallet.features[feature] as { signMessage?: unknown } | undefined;
  return canConnect(wallet) && typeof entry?.signMessage === 'function';
}

/** One name can now appear more than once; the list is for humans to pick from. */
function dedupeByName(wallets: StandardWallet[]): StandardWallet[] {
  const seen = new Set<string>();
  return wallets.filter((wallet) => {
    const key = wallet.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type SignMessageFeatureName = 'solana:signMessage' | 'bitcoin:signMessage';

export async function discoverSolanaWallets(waitMs = 120): Promise<StandardWallet[]> {
  const wallets = await discoverAll(waitMs);
  return dedupeByName(
    wallets.filter(
      (wallet) =>
        hasFeature(wallet, 'solana:signMessage') &&
        wallet.chains.some((chain) => chain.startsWith('solana:')),
    ),
  );
}

/**
 * Bitcoin wallets are matched on the signing feature alone. Chain identifiers
 * are not a reliable filter here: the Bitcoin Wallet Standard uses
 * `bitcoin:mainnet` while others advertise the CAIP-2 form
 * `bip122:000000000019d6689c085ae165831e93`, and a wallet that offers
 * `bitcoin:signMessage` is a Bitcoin wallet whichever it picked.
 */
export async function discoverBitcoinWallets(waitMs = 120): Promise<StandardWallet[]> {
  const wallets = await discoverAll(waitMs);
  return dedupeByName(wallets.filter((wallet) => hasFeature(wallet, 'bitcoin:signMessage')));
}

/**
 * Resolves a name back to a wallet. The feature is part of the lookup because
 * several same-named objects can be registered, one per chain.
 */
export function getStandardWalletByName(
  name: string,
  feature: SignMessageFeatureName,
): StandardWallet | undefined {
  for (const wallet of registry) {
    if (wallet.name === name && hasFeature(wallet, feature)) return wallet;
  }
  return undefined;
}
