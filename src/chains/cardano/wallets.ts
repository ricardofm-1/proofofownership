/**
 * CIP-30 wallet connections.
 *
 * Cardano wallets announce themselves as properties of `window.cardano`, each
 * an object with a name, an icon and an `enable()` that returns the actual API.
 * Unlike EIP-6963 there is no event to listen for, so discovery is a matter of
 * reading the object — which also means a wallet that injects late is missed,
 * and the dialog is opened fresh each time for that reason.
 *
 * Addresses cross this boundary as hex-encoded raw bytes rather than bech32,
 * so they are converted for display and passed back in the form the API wants.
 */

import { bytesToHex, hexToBytes } from '../../lib/bytes.ts';
import { UserRejectedError, WalletError, type Connection, type WalletOption } from '../types.ts';
import { encodeAddress } from './address.ts';

const INSTALL_URLS: Record<string, string> = {
  lace: 'https://www.lace.io/',
  eternl: 'https://eternl.io/',
  nami: 'https://namiwallet.io/',
  flint: 'https://flint-wallet.com/',
  typhoncip30: 'https://typhonwallet.io/',
  vespr: 'https://vespr.xyz/',
};

interface Cip30Api {
  getUsedAddresses(): Promise<string[]>;
  getUnusedAddresses?: () => Promise<string[]>;
  getChangeAddress?: () => Promise<string>;
  getRewardAddresses?: () => Promise<string[]>;
  signData(address: string, payload: string): Promise<{ signature: string; key: string }>;
}

interface Cip30Wallet {
  name?: string;
  icon?: string;
  apiVersion?: string;
  enable(): Promise<Cip30Api>;
  isEnabled?: () => Promise<boolean>;
}

/**
 * Some keys on `window.cardano` are not wallets — CIP-30 puts helper objects
 * there too — so an entry counts only if it can actually be enabled.
 */
function discover(): { id: string; wallet: Cip30Wallet }[] {
  const root = (globalThis as { cardano?: Record<string, unknown> }).cardano;
  if (!root || typeof root !== 'object') return [];

  const found: { id: string; wallet: Cip30Wallet }[] = [];
  for (const [id, value] of Object.entries(root)) {
    if (!value || typeof value !== 'object') continue;
    const candidate = value as Partial<Cip30Wallet>;
    if (typeof candidate.enable !== 'function') continue;
    found.push({ id, wallet: candidate as Cip30Wallet });
  }
  return found.sort((a, b) => walletLabel(a.id, a.wallet).localeCompare(walletLabel(b.id, b.wallet)));
}

function walletLabel(id: string, wallet: Cip30Wallet): string {
  return wallet.name?.trim() || id;
}

function isUserRejection(error: unknown): boolean {
  // CIP-30 defines APIError code 2 for a refused connection and DataSignError
  // code 1 for a refused signature.
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 2 || code === 1 || code === 4001) return true;
  const info = (error as { info?: unknown } | null)?.info;
  const text = `${typeof info === 'string' ? info : ''} ${
    error instanceof Error ? error.message : ''
  }`.toLowerCase();
  return text.includes('refus') || text.includes('reject') || text.includes('declin');
}

function toReadableError(error: unknown, fallback: string): Error {
  if (isUserRejection(error)) return new UserRejectedError();
  const info = (error as { info?: unknown } | null)?.info;
  if (typeof info === 'string' && info) return new WalletError(info);
  const message = (error as { message?: unknown } | null)?.message;
  return new WalletError(typeof message === 'string' && message ? message : fallback);
}

export function listCardanoWallets(): WalletOption[] {
  const wallets = discover();
  if (wallets.length > 0) {
    return wallets.map(({ id, wallet }) => ({
      id,
      name: walletLabel(id, wallet),
      icon: wallet.icon || undefined,
      available: true,
    }));
  }

  return [
    {
      id: 'lace',
      name: 'Lace',
      available: false,
      unavailableReason: 'Not detected in this browser',
      installUrl: INSTALL_URLS['lace'],
    },
    {
      id: 'eternl',
      name: 'Eternl',
      available: false,
      unavailableReason: 'Not detected in this browser',
      installUrl: INSTALL_URLS['eternl'],
    },
  ];
}

/**
 * Prefers an address the wallet has already used, since that is the one a
 * counterparty is likely to recognise; a fresh wallet has none, so the change
 * address stands in.
 */
async function chooseAddress(api: Cip30Api): Promise<string> {
  const used = await api.getUsedAddresses().catch(() => [] as string[]);
  const first = used[0];
  if (first) return first;

  const change = await api.getChangeAddress?.().catch(() => undefined);
  if (change) return change;

  const unused = await api.getUnusedAddresses?.().catch(() => [] as string[]);
  const fallback = unused?.[0];
  if (fallback) return fallback;

  throw new WalletError('The wallet exposed no address. Unlock it and try again.');
}

export async function connectCardanoWallet(walletId: string): Promise<Connection> {
  const entry = discover().find((candidate) => candidate.id === walletId);
  if (!entry) {
    const installUrl = INSTALL_URLS[walletId];
    throw new WalletError(
      'That wallet is no longer available. Reload the page and try again.',
      installUrl ? { actionUrl: installUrl, actionLabel: 'Install it' } : {},
    );
  }

  const name = walletLabel(entry.id, entry.wallet);
  let api: Cip30Api;
  try {
    api = await entry.wallet.enable();
  } catch (error) {
    throw toReadableError(error, `Could not connect to ${name}.`);
  }

  const addressHex = await chooseAddress(api);
  const addressBytes = hexToBytes(addressHex);
  const bech32Address = addressBytes ? encodeAddress(addressBytes) : null;
  if (!bech32Address) {
    throw new WalletError(
      `${name} returned an address this tool cannot read. Byron-era addresses are not supported.`,
    );
  }

  return {
    walletId,
    walletName: name,
    address: bech32Address,
    async signMessage(message: string): Promise<string> {
      const payload = bytesToHex(new TextEncoder().encode(message));
      let result: { signature: string; key: string };
      try {
        result = await api.signData(addressHex, payload);
      } catch (error) {
        throw toReadableError(error, `${name} could not sign this message.`);
      }
      if (!result?.signature || !result?.key) {
        throw new WalletError(`${name} returned an incomplete signature.`);
      }
      // Both halves are needed to verify, so the pair travels as the one string
      // the rest of the app treats as "the signature".
      return JSON.stringify({ signature: result.signature, key: result.key });
    },
    async disconnect(): Promise<void> {
      // CIP-30 has no disconnect; a session lasts as long as the page does.
    },
  };
}
