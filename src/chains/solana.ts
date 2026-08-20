import bs58 from 'bs58';
import nacl from 'tweetnacl';

import {
  discoverSolanaWallets,
  getSolanaWalletByName,
  type StandardWallet,
} from '../wallets/walletStandard.ts';
import {
  UserRejectedError,
  WalletError,
  type ChainAdapter,
  type Connection,
  type VerifyInput,
  type VerifyOutcome,
  type WalletOption,
} from './types.ts';

const PHANTOM_INSTALL_URL = 'https://phantom.app/download';
const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;

function isUserRejection(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 4001) return true;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return (
    message.includes('user rejected') ||
    message.includes('user denied') ||
    message.includes('rejected the request')
  );
}

function toReadableError(error: unknown, fallback: string): Error {
  if (isUserRejection(error)) return new UserRejectedError();
  const message = (error as { message?: unknown } | null)?.message;
  return new WalletError(typeof message === 'string' && message ? message : fallback);
}

function decodeBase58(value: string): Uint8Array | null {
  try {
    return bs58.decode(value);
  } catch {
    return null;
  }
}

function decodeHex(value: string): Uint8Array | null {
  const body = value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
  if (body.length === 0 || body.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(body)) {
    return null;
  }
  const bytes = new Uint8Array(body.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Solana signatures are canonically base58, but plenty of tooling emits hex.
 * Base58 is tried first because a base58 string can also look like valid hex.
 */
function decodeSignature(raw: string): Uint8Array | null {
  const cleaned = raw.trim().replace(/\s+/g, '');
  if (!cleaned) return null;
  const base58 = decodeBase58(cleaned);
  if (base58?.length === SIGNATURE_BYTES) return base58;
  const hex = decodeHex(cleaned);
  if (hex?.length === SIGNATURE_BYTES) return hex;
  return base58 ?? hex;
}

function walletOptionId(wallet: StandardWallet): string {
  return `standard:${wallet.name}`;
}

async function connectStandardWallet(walletId: string): Promise<Connection> {
  const name = walletId.replace(/^standard:/, '');
  let wallet = getSolanaWalletByName(name);
  if (!wallet) {
    await discoverSolanaWallets();
    wallet = getSolanaWalletByName(name);
  }
  if (!wallet) {
    throw new WalletError(
      'That wallet is no longer available. Reload the page and try again.',
    );
  }

  const connectFeature = wallet.features['standard:connect'];
  const signFeature = wallet.features['solana:signMessage'];
  if (!connectFeature || !signFeature) {
    throw new WalletError(`${wallet.name} does not support message signing.`);
  }

  let accounts: readonly { address: string }[];
  try {
    ({ accounts } = await connectFeature.connect());
  } catch (error) {
    throw toReadableError(error, `Could not connect to ${wallet.name}.`);
  }

  const account = wallet.accounts[0] ?? accounts[0];
  if (!account) {
    throw new WalletError(
      `${wallet.name} is connected but exposed no account. Unlock it and try again.`,
    );
  }

  const signingAccount = wallet.accounts.find((item) => item.address === account.address);
  if (!signingAccount) {
    throw new WalletError(`${wallet.name} did not expose a signable account.`);
  }

  return {
    walletId,
    walletName: wallet.name,
    address: signingAccount.address,
    async signMessage(message: string): Promise<string> {
      try {
        const results = await signFeature.signMessage({
          account: signingAccount,
          message: new TextEncoder().encode(message),
        });
        const signature = results[0]?.signature;
        if (!signature) throw new Error('The wallet returned no signature.');
        return bs58.encode(signature);
      } catch (error) {
        throw toReadableError(error, 'The wallet could not sign this message.');
      }
    },
    async disconnect(): Promise<void> {
      try {
        await wallet.features['standard:disconnect']?.disconnect();
      } catch {
        // Already disconnected is the state we were aiming for.
      }
    },
  };
}

export const solanaAdapter: ChainAdapter = {
  id: 'solana',
  name: 'Solana',
  addressPlaceholder: 'Base58 public key',
  signaturePlaceholder: 'Base58 signature',
  signatureEncoding: 'base58, 64 bytes',
  signingStandard: 'ed25519 over the raw UTF-8 message',
  verifyHint: '64-byte base58 signature. Hex is accepted too and converted internally.',

  async listWallets(): Promise<WalletOption[]> {
    const wallets = await discoverSolanaWallets();
    if (wallets.length === 0) {
      return [
        {
          id: 'standard:Phantom',
          name: 'Phantom',
          available: false,
          unavailableReason: 'Not detected in this browser',
          installUrl: PHANTOM_INSTALL_URL,
        },
      ];
    }

    return wallets.map((wallet) => ({
      id: walletOptionId(wallet),
      name: wallet.name,
      icon: wallet.icon || undefined,
      available: true,
    }));
  },

  async connect(walletId: string): Promise<Connection> {
    return connectStandardWallet(walletId);
  },

  async verify({ address, message, signature }: VerifyInput): Promise<VerifyOutcome> {
    const trimmedAddress = address.trim();
    if (!trimmedAddress) {
      return { status: 'malformed', reason: 'No address provided.', field: 'address' };
    }

    const publicKey = decodeBase58(trimmedAddress);
    if (!publicKey) {
      return {
        status: 'malformed',
        reason: 'That address is not valid base58. Solana addresses use base58 (no 0, O, I or l).',
        field: 'address',
      };
    }
    if (publicKey.length !== PUBLIC_KEY_BYTES) {
      return {
        status: 'malformed',
        reason: `That address decodes to ${publicKey.length} bytes; a Solana public key is ${PUBLIC_KEY_BYTES} bytes.`,
        field: 'address',
      };
    }

    const signatureBytes = decodeSignature(signature);
    if (!signatureBytes) {
      return {
        status: 'malformed',
        reason: 'The signature is not valid base58 or hex.',
        field: 'signature',
      };
    }
    if (signatureBytes.length !== SIGNATURE_BYTES) {
      return {
        status: 'malformed',
        reason: `The signature decodes to ${signatureBytes.length} bytes; an ed25519 signature is ${SIGNATURE_BYTES} bytes.`,
        field: 'signature',
      };
    }

    const messageBytes = new TextEncoder().encode(message);
    let isValid: boolean;
    try {
      isValid = nacl.sign.detached.verify(messageBytes, signatureBytes, publicKey);
    } catch {
      return {
        status: 'invalid',
        reason: 'The public key is not a valid point on the ed25519 curve.',
      };
    }

    if (isValid) return { status: 'valid', address: trimmedAddress };

    return {
      status: 'invalid',
      reason:
        'The signature is well-formed but does not match this address and message. ' +
        'ed25519 gives no way to recover the signer, so the address cannot be identified.',
    };
  },
};
