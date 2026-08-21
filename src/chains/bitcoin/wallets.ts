import { base64 } from '@scure/base';

import {
  discoverBitcoinWallets,
  getStandardWalletByName,
  type BitcoinSignMessageFeature,
  type StandardWallet,
  type WalletAccount,
} from '../../wallets/walletStandard.ts';
import {
  UserRejectedError,
  WalletError,
  type Connection,
  type WalletOption,
} from '../types.ts';
import { parseAddress } from './address.ts';

/**
 * Bitcoin browser wallets, discovered two ways.
 *
 * The Wallet Standard is the current route — Phantom, Magic Eden, Leather and
 * recent OKX builds all register through it, and Phantom has deprecated its
 * injected `window.phantom.bitcoin` provider entirely. UniSat and older OKX
 * builds still only expose a global, so those are probed as a fallback.
 *
 * Wallet Standard wins on name collisions, since a wallet that offers both is
 * telling us the injected object is the legacy path.
 */

interface UnisatLike {
  requestAccounts(): Promise<string[]>;
  signMessage(message: string, type?: 'ecdsa' | 'bip322-simple'): Promise<string>;
}

interface BitcoinGlobals {
  unisat?: UnisatLike;
  okxwallet?: { bitcoin?: UnisatLike };
}

interface InjectedDefinition {
  id: string;
  name: string;
  locate(globals: BitcoinGlobals): UnisatLike | undefined;
}

const INJECTED: InjectedDefinition[] = [
  {
    id: 'injected:unisat',
    name: 'UniSat',
    locate: (globals) => globals.unisat,
  },
  {
    // OKX mirrors UniSat's provider API.
    id: 'injected:okx',
    name: 'OKX Wallet',
    locate: (globals) => globals.okxwallet?.bitcoin,
  },
];

/**
 * Shown only when nothing at all is detected. Phantom is deliberately absent:
 * it registers Solana and Sui but no Bitcoin, so offering it here would tell
 * someone to install an extension they already have to get a chain it does
 * not serve.
 */
const SUGGESTIONS = [
  { id: 'suggest:metamask', name: 'MetaMask', installUrl: 'https://metamask.io/download' },
  { id: 'suggest:unisat', name: 'UniSat', installUrl: 'https://unisat.io/download' },
  { id: 'suggest:xverse', name: 'Xverse', installUrl: 'https://www.xverse.app/download' },
];

const STANDARD_PREFIX = 'standard:';

function globals(): BitcoinGlobals {
  return typeof window === 'undefined' ? {} : (window as unknown as BitcoinGlobals);
}

function isUserRejection(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 4001) return true;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return message.includes('reject') || message.includes('denied') || message.includes('cancel');
}

function toReadableError(error: unknown, fallback: string): Error {
  if (isUserRejection(error)) return new UserRejectedError();
  const message = (error as { message?: unknown } | null)?.message;
  return new WalletError(typeof message === 'string' && message ? message : fallback);
}

/**
 * Picks the signing standard the address can actually be verified under.
 * Legacy and nested-segwit addresses predate BIP-322 and are checked by key
 * recovery; native segwit and taproot use BIP-322.
 */
function signingTypeFor(address: string): 'ecdsa' | 'bip322-simple' {
  const parsed = parseAddress(address);
  if (!parsed) return 'bip322-simple';
  return parsed.kind === 'p2pkh' || parsed.kind === 'p2sh' ? 'ecdsa' : 'bip322-simple';
}

/**
 * Wallets often expose several Bitcoin accounts. Phantom separates a payment
 * account from an ordinals one, and signing with the ordinals address when
 * someone asked to prove control of their wallet would be surprising.
 */
function preferredAccount(accounts: readonly WalletAccount[]): WalletAccount | undefined {
  return (
    accounts.find((account) => account.purpose === 'payment') ??
    accounts.find((account) => parseAddress(account.address)?.kind === 'p2wpkh') ??
    accounts[0]
  );
}

function normaliseSignature(signature: Uint8Array | string): string {
  // Wallets return either raw bytes or an already-base64 string.
  return typeof signature === 'string' ? signature : base64.encode(signature);
}

/**
 * Implementations disagree on the message type: MetaMask's own examples pass a
 * string, while others expect UTF-8 bytes. There is no capability flag to read,
 * so a string is tried first and bytes are used as a fallback.
 *
 * The retry is safe because a failed call produced no signature. A rejection by
 * the user is re-thrown immediately rather than prompting them a second time.
 */
async function requestSignature(
  feature: BitcoinSignMessageFeature,
  account: WalletAccount,
  message: string,
): Promise<{ signature: Uint8Array | string } | { signature: Uint8Array | string }[]> {
  try {
    return await feature.signMessage({ account, message });
  } catch (error) {
    if (isUserRejection(error)) throw error;
    return feature.signMessage({ account, message: new TextEncoder().encode(message) });
  }
}

async function connectStandardWallet(walletId: string): Promise<Connection> {
  const name = walletId.slice(STANDARD_PREFIX.length);
  let wallet: StandardWallet | undefined = getStandardWalletByName(name, 'bitcoin:signMessage');
  if (!wallet) {
    await discoverBitcoinWallets();
    wallet = getStandardWalletByName(name, 'bitcoin:signMessage');
  }
  if (!wallet) {
    throw new WalletError('That wallet is no longer available. Reload the page and try again.');
  }

  const bitcoinConnect = wallet.features['bitcoin:connect'];
  const standardConnect = wallet.features['standard:connect'];
  const signFeature = wallet.features['bitcoin:signMessage'];
  if (!signFeature || (!bitcoinConnect && !standardConnect)) {
    throw new WalletError(`${wallet.name} does not support Bitcoin message signing.`);
  }

  let connected: readonly WalletAccount[];
  try {
    // `bitcoin:connect` wants the address types we intend to use. Asking only
    // for `payment` keeps ordinals and inscriptions out of the picture.
    ({ accounts: connected } = bitcoinConnect
      ? await bitcoinConnect.connect({ purposes: ['payment'] })
      : await (standardConnect as NonNullable<typeof standardConnect>).connect());
  } catch (error) {
    throw toReadableError(error, `Could not connect to ${wallet.name}.`);
  }

  // Wallets expose no accounts until connect() authorises them, so the
  // returned list is the authoritative one; `wallet.accounts` is a fallback.
  const pool = connected.length > 0 ? connected : wallet.accounts;
  const account = preferredAccount(pool);
  if (!account) {
    throw new WalletError(
      `${wallet.name} is connected but exposed no Bitcoin account. Unlock it and try again.`,
    );
  }

  return {
    walletId,
    walletName: wallet.name,
    address: account.address,
    async signMessage(message: string): Promise<string> {
      try {
        const result = await requestSignature(signFeature, account, message);
        const first = Array.isArray(result) ? result[0] : result;
        if (!first?.signature) throw new Error('The wallet returned no signature.');
        return normaliseSignature(first.signature);
      } catch (error) {
        throw toReadableError(error, 'The wallet could not sign this message.');
      }
    },
    async disconnect(): Promise<void> {
      try {
        const feature =
          wallet.features['bitcoin:disconnect'] ?? wallet.features['standard:disconnect'];
        await feature?.disconnect();
      } catch {
        // Already disconnected is the state we were aiming for.
      }
    },
  };
}

async function connectInjectedWallet(walletId: string): Promise<Connection> {
  const definition = INJECTED.find((wallet) => wallet.id === walletId);
  if (!definition) {
    throw new WalletError('That wallet is no longer available. Reload the page and try again.');
  }

  const provider = definition.locate(globals());
  if (!provider) {
    throw new WalletError(
      `${definition.name} is no longer available. Reload the page and try again.`,
    );
  }

  const unisat = provider;
  let accounts: string[];
  try {
    accounts = await unisat.requestAccounts();
  } catch (error) {
    throw toReadableError(error, `Could not connect to ${definition.name}.`);
  }

  const address = accounts[0];
  if (!address) {
    throw new WalletError(
      `${definition.name} is connected but has no account unlocked. Unlock it and try again.`,
    );
  }

  return {
    walletId,
    walletName: definition.name,
    address,
    async signMessage(message: string): Promise<string> {
      try {
        return await unisat.signMessage(message, signingTypeFor(address));
      } catch (error) {
        throw toReadableError(error, 'The wallet could not sign this message.');
      }
    },
    async disconnect(): Promise<void> {},
  };
}

export async function listBitcoinWallets(): Promise<WalletOption[]> {
  const standard = await discoverBitcoinWallets();
  const options: WalletOption[] = standard.map((wallet) => ({
    id: `${STANDARD_PREFIX}${wallet.name}`,
    name: wallet.name,
    icon: wallet.icon || undefined,
    available: true,
  }));

  const seen = new Set(standard.map((wallet) => wallet.name.toLowerCase()));
  const found = globals();
  for (const definition of INJECTED) {
    if (seen.has(definition.name.toLowerCase())) continue;
    if (!definition.locate(found)) continue;
    options.push({ id: definition.id, name: definition.name, available: true });
    seen.add(definition.name.toLowerCase());
  }

  // Only advertise installs when there is genuinely nothing to connect to.
  // Listing a specific wallet as "not detected" is misleading when the user
  // may have a perfectly good one this tool simply did not name.
  if (options.length === 0) {
    return SUGGESTIONS.map((suggestion) => ({
      id: suggestion.id,
      name: suggestion.name,
      available: false,
      unavailableReason: 'Not detected in this browser',
      installUrl: suggestion.installUrl,
    }));
  }

  return options;
}

export async function connectBitcoinWallet(walletId: string): Promise<Connection> {
  return walletId.startsWith(STANDARD_PREFIX)
    ? connectStandardWallet(walletId)
    : connectInjectedWallet(walletId);
}
