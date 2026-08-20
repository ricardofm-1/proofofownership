/**
 * Minimal Wallet Standard registry (the Solana equivalent of EIP-6963).
 *
 * The official `@wallet-standard/app` package does exactly this, but the
 * protocol is ~40 lines of event plumbing and this is a trust-sensitive tool,
 * so we keep the dependency out and the mechanism visible. Phantom, Solflare
 * and Backpack all register through it, which means one code path covers them.
 */

export interface WalletAccount {
  /** Base58 public key for Solana wallets. */
  address: string;
  publicKey: Uint8Array;
  chains: readonly string[];
  features: readonly string[];
}

interface ConnectFeature {
  connect(input?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccount[] }>;
}

interface DisconnectFeature {
  disconnect(): Promise<void>;
}

interface SignMessageFeature {
  signMessage(
    ...inputs: { account: WalletAccount; message: Uint8Array }[]
  ): Promise<{ signedMessage: Uint8Array; signature: Uint8Array }[]>;
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
  };
  accounts: readonly WalletAccount[];
}

/** The object wallets receive so they can hand us their implementation. */
interface WalletStandardApi {
  register(...wallets: StandardWallet[]): () => void;
  get(): readonly StandardWallet[];
  on(event: string, listener: (...args: never[]) => void): () => void;
}

const registry = new Map<string, StandardWallet>();
let listening = false;

function register(...wallets: StandardWallet[]): () => void {
  for (const wallet of wallets) {
    if (wallet?.name) registry.set(wallet.name, wallet);
  }
  return () => {
    for (const wallet of wallets) registry.delete(wallet.name);
  };
}

const api: WalletStandardApi = {
  register,
  get: () => [...registry.values()],
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

/** Returns every registered wallet that can both connect and sign messages. */
export async function discoverSolanaWallets(waitMs = 120): Promise<StandardWallet[]> {
  if (typeof window === 'undefined') return [];
  startListening();

  // Wallets that loaded before us are idling until they see `app-ready`.
  window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
  await new Promise((resolve) => setTimeout(resolve, waitMs));

  return [...registry.values()].filter(
    (wallet) =>
      typeof wallet.features['standard:connect']?.connect === 'function' &&
      typeof wallet.features['solana:signMessage']?.signMessage === 'function' &&
      wallet.chains.some((chain) => chain.startsWith('solana:')),
  );
}

export function getSolanaWalletByName(name: string): StandardWallet | undefined {
  return registry.get(name);
}
