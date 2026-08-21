/**
 * Checking that a signed XRPL transaction really was signed.
 *
 * There is no settled standard for signing plain text on the XRP Ledger: the
 * wallets that offer it disagree on what bytes go under the signature, and
 * several do not document it at all. Transaction signing, by contrast, is
 * specified exactly and is what every XRPL key is already used for. So a proof
 * here is an ordinary signed transaction that carries the message in a memo —
 * the same manoeuvre BIP-322 makes on Bitcoin, and for the same reason.
 */

import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha512 } from '@noble/hashes/sha2';

import {
  accountIdToAddress,
  addressFromPublicKey,
  classifyPublicKey,
  type KeyType,
} from './address.ts';
import {
  FIELD,
  findField,
  parseFields,
  readMemos,
  singleSigningData,
  XrplParseError,
} from './binary.ts';

/** rippled hashes with SHA-512 and keeps the first half. */
function sha512Half(bytes: Uint8Array): Uint8Array {
  return sha512(bytes).slice(0, 32);
}

export interface SingleSignedProof {
  kind: 'single';
  /** The account the transaction claims to act for. */
  account: string;
  /** The account the signing key actually belongs to. */
  signer: string;
  keyType: KeyType;
  memos: string[];
  signatureValid: boolean;
}

export interface MultiSignedProof {
  kind: 'multi-signed';
  account: string;
  memos: string[];
}

export type SignedTransaction = SingleSignedProof | MultiSignedProof;

/**
 * Verifies the signature on a serialised transaction and reports who signed it.
 * Throws `XrplParseError` when the bytes are not a transaction at all.
 */
export function inspectSignedTransaction(bytes: Uint8Array): SignedTransaction {
  const fields = parseFields(bytes);

  const accountId = findField(fields, FIELD.account);
  if (!accountId || accountId.length !== 20) {
    throw new XrplParseError('The transaction has no account field.');
  }
  const account = accountIdToAddress(accountId);
  const memos = readMemos(fields);

  const publicKey = findField(fields, FIELD.signingPubKey);
  const signature = findField(fields, FIELD.txnSignature);

  // An empty signing key is how a transaction says it was signed by a quorum of
  // other accounts instead of by its own key.
  if (!publicKey || publicKey.length === 0 || !signature) {
    return { kind: 'multi-signed', account, memos };
  }

  const keyType = classifyPublicKey(publicKey);
  if (!keyType) throw new XrplParseError('The signing public key is not a valid XRPL key.');

  const signed = singleSigningData(fields);
  let signatureValid = false;
  try {
    if (keyType === 'ed25519') {
      // ed25519 hashes internally, so it signs the payload as-is.
      signatureValid = ed25519.verify(signature, signed, publicKey.slice(1));
    } else {
      const parsed = secp256k1.Signature.fromDER(signature);
      signatureValid = secp256k1.verify(
        parsed.toBytes('compact'),
        sha512Half(signed),
        publicKey,
        // A high-S signature is malleable but proves key possession just as
        // well, and rejecting one would be a false negative on a real proof.
        { lowS: false },
      );
    }
  } catch {
    signatureValid = false;
  }

  return {
    kind: 'single',
    account,
    signer: addressFromPublicKey(publicKey),
    keyType,
    memos,
    signatureValid,
  };
}
