import type { Hex } from 'viem';
// Imported from the `viem/utils` subpath rather than the package barrel: the
// barrel is also pulled in by WalletConnect, and sharing it makes the bundler
// hoist a large slice of viem into the eagerly loaded entry chunk.
import {
  getAddress,
  isAddress,
  isAddressEqual,
  recoverMessageAddress,
  toHex,
} from 'viem/utils';

import {
  discoverInjectedProviders,
  getProviderByUuid,
  type Eip1193Provider,
} from '../wallets/eip6963.ts';
import {
  UserRejectedError,
  WalletError,
  type ChainAdapter,
  type Connection,
  type VerifyInput,
  type VerifyOutcome,
  type WalletOption,
} from './types.ts';

const WALLETCONNECT_ID = 'walletconnect';
const METAMASK_INSTALL_URL = 'https://metamask.io/download/';

type WalletConnectProvider = Awaited<
  ReturnType<(typeof import('@walletconnect/ethereum-provider'))['EthereumProvider']['init']>
>;

let walletConnectProvider: WalletConnectProvider | null = null;

const EVM_CHAINS = [1, 10, 56, 137, 8453, 42161, 43114] as const;

/** CAIP-10 account ids (`eip155:1:0x…`) from a WalletConnect eip155 namespace. */
export function pickSessionAccounts(caipAccounts: string[]): {
  chainId: number;
  addresses: string[];
} | null {
  const first = caipAccounts[0];
  if (!first) return null;
  const [, chainPart, address] = first.split(':');
  const chainId = Number(chainPart);
  if (!Number.isFinite(chainId) || chainId <= 0 || !address) return null;
  const addresses = caipAccounts.flatMap((caip) => {
    const parts = caip.split(':');
    const id = Number(parts[1]);
    const addr = parts[2];
    return id === chainId && addr ? [addr] : [];
  });
  return addresses.length ? { chainId, addresses } : null;
}

function eip155Accounts(provider: WalletConnectProvider): string[] {
  const namespaces = provider.session?.namespaces;
  if (!namespaces) return [];
  return Object.entries(namespaces)
    .filter(([key]) => key === 'eip155' || key.startsWith('eip155:'))
    .flatMap(([, value]) => value.accounts ?? []);
}

function syncWalletConnectChain(provider: WalletConnectProvider): void {
  const picked = pickSessionAccounts(eip155Accounts(provider));
  if (!picked) return;
  provider.chainId = picked.chainId;
  provider.accounts = picked.addresses;
}

const SMART_WALLET_HINT =
  'If this address is a smart-contract wallet (Safe, Argent, Coinbase Smart Wallet), ' +
  'it signs via EIP-1271, which can only be checked against an on-chain call. ' +
  'This tool is offline-only, so it cannot confirm those signatures yet.';

/** EIP-1193 rejection code, plus the variant some wallets use for a closed modal. */
function isUserRejection(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 4001 || code === 'ACTION_REJECTED') return true;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return (
    message.includes('user rejected') ||
    message.includes('user denied') ||
    message.includes('connection request reset')
  );
}

function toReadableError(error: unknown, fallback: string): Error {
  if (isUserRejection(error)) return new UserRejectedError();
  const message = (error as { message?: unknown } | null)?.message;
  return new WalletError(typeof message === 'string' && message ? message : fallback);
}

/**
 * Coerces the many shapes a 65-byte secp256k1 signature arrives in into the
 * canonical `0x`-prefixed r‖s‖v form that viem expects.
 *
 * Accepts: missing `0x`, surrounding whitespace, a `v` of 0/1 instead of 27/28,
 * and the 64-byte EIP-2098 compact form that packs `yParity` into the top bit
 * of `s`.
 */
function normalizeSignature(
  raw: string,
): { ok: true; signature: Hex } | { ok: false; reason: string } {
  const cleaned = raw.trim().replace(/\s+/g, '');
  if (!cleaned) return { ok: false, reason: 'No signature provided.' };

  const body = cleaned.startsWith('0x') || cleaned.startsWith('0X')
    ? cleaned.slice(2)
    : cleaned;

  if (!/^[0-9a-fA-F]*$/.test(body)) {
    return {
      ok: false,
      reason: 'The signature contains characters that are not hexadecimal.',
    };
  }

  if (body.length === 130) {
    const v = Number.parseInt(body.slice(128), 16);
    if (v === 0 || v === 1) {
      const normalizedV = (v + 27).toString(16).padStart(2, '0');
      return { ok: true, signature: `0x${body.slice(0, 128)}${normalizedV}` };
    }
    if (v !== 27 && v !== 28) {
      return {
        ok: false,
        reason: `The recovery byte is 0x${body.slice(128)}; it must be 00, 01, 1b or 1c.`,
      };
    }
    return { ok: true, signature: `0x${body.toLowerCase()}` };
  }

  if (body.length === 128) {
    // EIP-2098 compact: yParity lives in the most significant bit of `s`.
    const r = body.slice(0, 64);
    const yParityAndS = body.slice(64);
    const firstByte = Number.parseInt(yParityAndS.slice(0, 2), 16);
    const yParity = (firstByte & 0x80) >> 7;
    const s = (firstByte & 0x7f).toString(16).padStart(2, '0') + yParityAndS.slice(2);
    const v = (27 + yParity).toString(16).padStart(2, '0');
    return { ok: true, signature: `0x${r}${s}${v}`.toLowerCase() as Hex };
  }

  return {
    ok: false,
    reason:
      `The signature is ${body.length / 2} bytes long. An Ethereum ` +
      'personal_sign signature is 65 bytes (132 characters including "0x").',
  };
}

function normalizeAddress(
  raw: string,
): { ok: true; address: `0x${string}` } | { ok: false; reason: string } {
  const cleaned = raw.trim();
  if (!cleaned) return { ok: false, reason: 'No address provided.' };
  // Lowercase first: any checksum casing is accepted, valid or not.
  if (!isAddress(cleaned.toLowerCase(), { strict: false })) {
    return {
      ok: false,
      reason: 'That is not a valid Ethereum address (expected 0x followed by 40 hex characters).',
    };
  }
  return { ok: true, address: getAddress(cleaned.toLowerCase()) };
}

async function connectInjected(walletId: string): Promise<Connection> {
  const uuid = walletId.replace(/^injected:/, '');
  let detail = getProviderByUuid(uuid);
  if (!detail) {
    await discoverInjectedProviders();
    detail = getProviderByUuid(uuid);
  }
  if (!detail) {
    throw new WalletError(
      'That wallet is no longer available. Reload the page and try again.',
    );
  }

  const provider: Eip1193Provider = detail.provider;
  let accounts: string[];
  try {
    accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
  } catch (error) {
    throw toReadableError(error, `Could not connect to ${detail.info.name}.`);
  }

  const account = accounts[0];
  if (!account) {
    throw new WalletError(
      `${detail.info.name} is connected but has no accounts unlocked. Unlock it and try again.`,
    );
  }

  return {
    walletId,
    walletName: detail.info.name,
    address: getAddress(account),
    async signMessage(message: string): Promise<string> {
      try {
        const signature = await provider.request({
          method: 'personal_sign',
          params: [toHex(message), account],
        });
        return String(signature);
      } catch (error) {
        throw toReadableError(error, 'The wallet could not sign this message.');
      }
    },
    async disconnect(): Promise<void> {
      // Injected wallets own their permission state; there is nothing to revoke
      // from our side beyond dropping the reference.
    },
  };
}

async function connectWalletConnect(): Promise<Connection> {
  const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID;
  if (!projectId) {
    throw new WalletError(
      'WalletConnect needs a Reown project ID. Build this site with VITE_WALLETCONNECT_PROJECT_ID set.',
      { actionUrl: 'https://cloud.reown.com', actionLabel: 'Get a free project ID' },
    );
  }

  // Loaded on demand: the Verify tab must never pull the WalletConnect bundle,
  // and nobody should pay for it just by opening the page.
  const { EthereumProvider } = await import('@walletconnect/ethereum-provider');

  if (!walletConnectProvider) {
    walletConnectProvider = await EthereumProvider.init({
      projectId,
      // Required by this provider version, but kept to a single chain so the
      // session proposal is small. The wallet’s actual chain is synced after
      // connect — see syncWalletConnectChain.
      chains: [1],
      optionalChains: [...EVM_CHAINS],
      methods: ['personal_sign'],
      optionalMethods: ['personal_sign', 'eth_sign', 'eth_requestAccounts', 'eth_accounts'],
      events: ['accountsChanged', 'chainChanged'],
      showQrModal: true,
      metadata: {
        name: 'Proof of Ownership',
        description: 'Sign and verify wallet messages entirely in your browser.',
        url: window.location.origin,
        icons: [`${window.location.origin}/apple-touch-icon.png`],
      },
    });
    walletConnectProvider.on('disconnect', () => {
      walletConnectProvider = null;
    });
  }

  const provider = walletConnectProvider;
  try {
    // `enable()` follows connect with `eth_requestAccounts`, which many mobile
    // wallets surface as a second “sign” and then never answer. `connect()`
    // already fills `provider.accounts` from the approved session.
    if (!provider.session) await provider.connect();
    syncWalletConnectChain(provider);
  } catch (error) {
    throw toReadableError(error, 'Could not establish a WalletConnect session.');
  }

  const account = provider.accounts[0];
  if (!account) {
    throw new WalletError('WalletConnect connected but returned no account.');
  }

  return {
    walletId: WALLETCONNECT_ID,
    walletName: 'WalletConnect',
    address: getAddress(account),
    async signMessage(message: string): Promise<string> {
      try {
        syncWalletConnectChain(provider);
        const from = provider.accounts[0] ?? account;
        const signature = await provider.request({
          method: 'personal_sign',
          params: [toHex(message), from],
        });
        return String(signature);
      } catch (error) {
        throw toReadableError(error, 'The wallet could not sign this message.');
      }
    },
    async disconnect(): Promise<void> {
      try {
        await provider.disconnect();
      } catch {
        // A session that is already gone is the outcome we wanted anyway.
      }
      walletConnectProvider = null;
    },
  };
}

export const ethereumAdapter: ChainAdapter = {
  id: 'ethereum',
  name: 'Ethereum',
  addressPlaceholder: '0x…',
  signaturePlaceholder: '0x…',
  signatureEncoding: 'hex (0x…), 65 bytes',
  signingStandard: 'EIP-191 personal_sign',
  verifyHint:
    '65-byte hex signature. The 0x prefix is optional, and the address may use any ' +
    'checksum casing.',

  async listWallets(): Promise<WalletOption[]> {
    const injected = await discoverInjectedProviders();
    const options: WalletOption[] = injected.map((detail) => ({
      id: `injected:${detail.info.uuid}`,
      name: detail.info.name,
      icon: detail.info.icon || undefined,
      available: true,
    }));

    if (options.length === 0) {
      options.push({
        id: 'injected:none',
        name: 'MetaMask',
        available: false,
        unavailableReason: 'Not detected in this browser',
        installUrl: METAMASK_INSTALL_URL,
      });
    }

    const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID;
    options.push({
      id: WALLETCONNECT_ID,
      name: 'WalletConnect',
      available: Boolean(projectId),
      unavailableReason: projectId ? undefined : 'Needs a Reown project ID at build time',
      installUrl: projectId ? undefined : 'https://cloud.reown.com',
    });

    return options;
  },

  async connect(walletId: string): Promise<Connection> {
    if (walletId === WALLETCONNECT_ID) return connectWalletConnect();
    return connectInjected(walletId);
  },

  async verify({ address, message, signature }: VerifyInput): Promise<VerifyOutcome> {
    const parsedAddress = normalizeAddress(address);
    if (!parsedAddress.ok) {
      return { status: 'malformed', reason: parsedAddress.reason, field: 'address' };
    }

    const parsedSignature = normalizeSignature(signature);
    if (!parsedSignature.ok) {
      return { status: 'malformed', reason: parsedSignature.reason, field: 'signature' };
    }

    let recovered: `0x${string}`;
    try {
      recovered = await recoverMessageAddress({
        message,
        signature: parsedSignature.signature,
      });
    } catch {
      return {
        status: 'invalid',
        reason: 'No public key can be recovered from this signature — the r/s values are not on the curve.',
        hint: SMART_WALLET_HINT,
      };
    }

    if (isAddressEqual(recovered, parsedAddress.address)) {
      return { status: 'valid', address: parsedAddress.address };
    }

    return {
      status: 'invalid',
      reason: 'The signature is well-formed, but it was produced by a different address.',
      recoveredAddress: recovered,
      hint: SMART_WALLET_HINT,
    };
  },
};
