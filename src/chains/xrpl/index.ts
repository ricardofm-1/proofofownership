import { hexToBytes } from '../../lib/bytes.ts';
import type { ChainAdapter, Connection, VerifyInput, VerifyOutcome, WalletOption } from '../types.ts';
import { addressToAccountId } from './address.ts';
import { XrplParseError } from './binary.ts';
import { inspectSignedTransaction } from './proof.ts';
import { connectXrplWallet, listXrplWallets } from './wallets.ts';

const VERIFY_HINT =
  'Paste the signed transaction blob, as hex. The proof is a transaction signed by ' +
  'your account with the message in a memo; the public key travels inside it, which ' +
  'is why no separate key is needed here.';

export const xrplAdapter: ChainAdapter = {
  id: 'xrpl',
  name: 'XRP Ledger',
  addressPlaceholder: 'Classic address (r…)',
  signaturePlaceholder: 'Signed transaction blob (hex)',
  signatureEncoding: 'hex, a serialised signed transaction',
  signingStandard: 'signed transaction with the message in a memo',
  verifyHint: VERIFY_HINT,

  async listWallets(): Promise<WalletOption[]> {
    return listXrplWallets();
  },

  async connect(walletId: string): Promise<Connection> {
    return connectXrplWallet(walletId);
  },

  async verify({ address, message, signature }: VerifyInput): Promise<VerifyOutcome> {
    const claimed = address.trim();
    if (!claimed) {
      return { status: 'malformed', reason: 'No address provided.', field: 'address' };
    }
    if (!addressToAccountId(claimed)) {
      return {
        status: 'malformed',
        reason:
          'That is not a valid XRP Ledger address. Classic addresses start with “r” and ' +
          'carry a checksum, which this one fails.',
        field: 'address',
      };
    }

    const cleaned = signature.trim().replace(/\s+/g, '');
    if (!cleaned) {
      return { status: 'malformed', reason: 'No signed transaction provided.', field: 'signature' };
    }
    const blob = hexToBytes(cleaned);
    if (!blob) {
      return {
        status: 'malformed',
        reason: 'The signed transaction is not valid hex.',
        field: 'signature',
      };
    }

    let proof;
    try {
      proof = inspectSignedTransaction(blob);
    } catch (error) {
      if (error instanceof XrplParseError) {
        return { status: 'malformed', reason: error.message, field: 'signature' };
      }
      return {
        status: 'malformed',
        reason: 'That does not decode as an XRP Ledger transaction.',
        field: 'signature',
      };
    }

    // A quorum of other accounts signed this. Which accounts are entitled to do
    // so lives in the account's signer list on the ledger, and reading it would
    // mean going online — so this tool has nothing to say either way.
    if (proof.kind === 'multi-signed') {
      return {
        status: 'unsupported',
        reason:
          'This transaction is multi-signed. Confirming it needs the account’s signer list, ' +
          'which only the ledger holds.',
        hint: 'Verification here is offline by design, so it never consults the network.',
      };
    }

    if (!proof.signatureValid) {
      return {
        status: 'invalid',
        reason:
          'The signature does not match this transaction. Either the transaction was altered ' +
          'after signing, or the signature was not made by the key it names.',
      };
    }

    if (proof.account !== claimed) {
      return {
        status: 'invalid',
        reason: 'This transaction is correctly signed, but it belongs to a different account.',
        recoveredAddress: proof.account,
      };
    }

    const matchesMessage = proof.memos.some((memo) => memo === message);
    if (!matchesMessage) {
      return {
        status: 'invalid',
        reason:
          proof.memos.length === 0
            ? 'This transaction is correctly signed but carries no memo, so it commits to no message.'
            : 'This transaction is correctly signed, but the message it commits to is not this one.',
        hint:
          proof.memos.length > 0
            ? 'Memos must match exactly, including whitespace and line endings.'
            : undefined,
      };
    }

    // XRPL lets an account authorise a second "regular" key to sign for it. A
    // signature from one is perfectly legitimate, but only the ledger records
    // which key an account has authorised, so this cannot be settled offline.
    if (proof.signer !== proof.account) {
      return {
        status: 'unsupported',
        reason:
          'The signing key does not belong to this account, which is what a regular key or a ' +
          'compromised signature both look like from here.',
        hint: `The key used belongs to ${proof.signer}. Confirming it is an authorised regular key needs the ledger.`,
      };
    }

    return { status: 'valid', address: proof.account };
  },
};
