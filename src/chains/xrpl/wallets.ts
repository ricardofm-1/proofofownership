/**
 * XRPL wallet connections.
 *
 * The proof is a signed transaction, so what we ask a wallet for is a signature
 * over an `AccountSet` carrying the message in a memo. `AccountSet` with no
 * settings changes nothing even if it were submitted, and the transaction is
 * built so that it cannot be: a zero fee is below the network minimum and a
 * `LastLedgerSequence` of zero expired before any ledger that could hold it.
 * Two independent reasons, because a wallet that helpfully rewrites one of them
 * should not be able to turn a proof into a broadcastable transaction.
 */

import { UserRejectedError, WalletError, type Connection, type WalletOption } from '../types.ts';
import { bytesToHex } from '../../lib/bytes.ts';

const CROSSMARK_INSTALL_URL = 'https://crossmark.io/';
const GEM_WALLET_INSTALL_URL = 'https://gemwallet.app/';
const XAMAN_INSTALL_URL = 'https://xaman.app/';

const MEMO_TYPE = 'proof-of-ownership';

interface CrossmarkResponse {
  response?: { data?: Record<string, unknown> } | undefined;
}

interface CrossmarkApi {
  signInAndWait?: () => Promise<CrossmarkResponse>;
  signAndWait?: (transaction: Record<string, unknown>) => Promise<CrossmarkResponse>;
}

interface CrossmarkGlobal {
  sync?: { isInstalled?: () => boolean; getAddress?: () => string | undefined } | undefined;
  async?: CrossmarkApi | undefined;
  methods?: CrossmarkApi | undefined;
  signInAndWait?: CrossmarkApi['signInAndWait'] | undefined;
  signAndWait?: CrossmarkApi['signAndWait'] | undefined;
}

function crossmarkGlobal(): CrossmarkGlobal | null {
  const candidate = (globalThis as { crossmark?: unknown }).crossmark;
  return candidate && typeof candidate === 'object' ? (candidate as CrossmarkGlobal) : null;
}

/**
 * Crossmark has shipped its methods under `async`, under `methods`, and on the
 * object itself across versions, so each is tried rather than pinning one.
 */
function crossmarkMethod<K extends keyof CrossmarkApi>(
  wallet: CrossmarkGlobal,
  name: K,
): NonNullable<CrossmarkApi[K]> | null {
  for (const holder of [wallet.async, wallet.methods, wallet as CrossmarkApi]) {
    const method = holder?.[name];
    if (typeof method === 'function') return method.bind(holder) as NonNullable<CrossmarkApi[K]>;
  }
  return null;
}

function isUserRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes('reject') ||
    message.includes('denied') ||
    message.includes('cancel') ||
    message.includes('closed')
  );
}

function toReadableError(error: unknown, fallback: string): Error {
  if (isUserRejection(error)) return new UserRejectedError();
  const message = (error as { message?: unknown } | null)?.message;
  return new WalletError(typeof message === 'string' && message ? message : fallback);
}

function hexOfUtf8(value: string): string {
  return bytesToHex(new TextEncoder().encode(value)).toUpperCase();
}

/** An intentionally unbroadcastable transaction that carries the message. */
export function buildProofTransaction(address: string, message: string): Record<string, unknown> {
  return {
    TransactionType: 'AccountSet',
    Account: address,
    Fee: '0',
    Sequence: 0,
    LastLedgerSequence: 0,
    Flags: 0,
    Memos: [
      {
        Memo: {
          MemoType: hexOfUtf8(MEMO_TYPE),
          MemoFormat: hexOfUtf8('text/plain'),
          MemoData: hexOfUtf8(message),
        },
      },
    ],
  };
}

/** Digs the signed blob out of a response whose shape has moved around. */
function readSignedBlob(result: CrossmarkResponse): string | null {
  const data = result.response?.data;
  if (!data) return null;
  for (const key of ['txBlob', 'tx_blob', 'signedTransaction', 'blob']) {
    const value = data[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

export function listXrplWallets(): WalletOption[] {
  const crossmark = crossmarkGlobal();
  const installed = Boolean(crossmark?.sync?.isInstalled?.() ?? crossmark);

  if (installed) {
    return [{ id: 'crossmark', name: 'Crossmark', available: true }];
  }

  return [
    {
      id: 'crossmark',
      name: 'Crossmark',
      available: false,
      unavailableReason: 'Not detected in this browser',
      installUrl: CROSSMARK_INSTALL_URL,
    },
    {
      id: 'gemwallet',
      name: 'GemWallet',
      available: false,
      unavailableReason: 'Not supported here yet — paste a signed transaction in Verify',
      installUrl: GEM_WALLET_INSTALL_URL,
    },
    {
      id: 'xaman',
      name: 'Xaman',
      available: false,
      unavailableReason: 'Not supported here yet — paste a signed transaction in Verify',
      installUrl: XAMAN_INSTALL_URL,
    },
  ];
}

export async function connectXrplWallet(walletId: string): Promise<Connection> {
  if (walletId !== 'crossmark') {
    throw new WalletError(
      'Only Crossmark can sign here so far. Any XRPL wallet works in the Verify tab: ' +
        'sign a transaction carrying your message in a memo and paste the signed blob.',
    );
  }

  const wallet = crossmarkGlobal();
  if (!wallet) {
    throw new WalletError('Crossmark is not available. Install it and reload the page.', {
      actionUrl: CROSSMARK_INSTALL_URL,
      actionLabel: 'Get Crossmark',
    });
  }

  const signIn = crossmarkMethod(wallet, 'signInAndWait');
  const sign = crossmarkMethod(wallet, 'signAndWait');
  if (!signIn || !sign) {
    throw new WalletError('This version of Crossmark does not expose the signing API.');
  }

  let address: string | undefined;
  try {
    const result = await signIn();
    const data = result.response?.data;
    const candidate = data?.['address'];
    address = typeof candidate === 'string' ? candidate : wallet.sync?.getAddress?.();
  } catch (error) {
    throw toReadableError(error, 'Could not connect to Crossmark.');
  }

  if (!address) {
    throw new WalletError('Crossmark connected but exposed no account. Unlock it and try again.');
  }
  const account = address;

  return {
    walletId,
    walletName: 'Crossmark',
    address: account,
    async signMessage(message: string): Promise<string> {
      let result: CrossmarkResponse;
      try {
        result = await sign(buildProofTransaction(account, message));
      } catch (error) {
        throw toReadableError(error, 'Crossmark could not sign this message.');
      }
      const blob = readSignedBlob(result);
      if (!blob) throw new WalletError('Crossmark returned no signed transaction.');
      return blob;
    },
    async disconnect(): Promise<void> {
      // Crossmark has no disconnect method; the session ends with the page.
    },
  };
}
