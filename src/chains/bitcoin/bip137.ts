import { secp256k1 } from '@noble/curves/secp256k1';

import { concatBytes, varBytes } from '../../lib/bytes.ts';
import { addressesForPublicKey, sha256d, type AddressKind, type Network } from './address.ts';

/**
 * BIP-137 / "Bitcoin Signed Message" — the legacy scheme.
 *
 * This is what Bitcoin Core's `signmessage`, Electrum and most hardware
 * wallets produce: a 65-byte recoverable ECDSA signature over a double-SHA256
 * of the magic-prefixed message, base64-encoded. The public key is recovered
 * from the signature, so verification only needs the address.
 */

const MAGIC = new TextEncoder().encode('Bitcoin Signed Message:\n');

export function bip137MessageHash(message: string): Uint8Array {
  const messageBytes = new TextEncoder().encode(message);
  return sha256d(concatBytes(varBytes(MAGIC), varBytes(messageBytes)));
}

export interface Bip137Result {
  /** Every address the recovered key can produce, mapped to its script type. */
  candidates: Map<string, AddressKind>;
  /** What the header byte claims the signer used. */
  claimedKind: AddressKind | null;
}

/**
 * Recovers the signer's public key and enumerates the addresses it controls.
 *
 * The header byte encodes both the recovery id and the intended address type,
 * but signers set the type inconsistently in practice, so it is reported
 * rather than enforced. The security-relevant part is the recovered key: if it
 * produces the address under test, that key signed this message.
 */
export function recoverBip137(
  message: string,
  signature: Uint8Array,
  network: Network,
): Bip137Result | { error: string } {
  if (signature.length !== 65) {
    return { error: `A BIP-137 signature is 65 bytes; this one is ${signature.length}.` };
  }

  const header = signature[0] as number;
  if (header < 27 || header > 42) {
    return {
      error: `The header byte is ${header}; a BIP-137 signature uses 27–42.`,
    };
  }

  const recoveryId = (header - 27) & 3;
  const claimedKind = ((): AddressKind | null => {
    if (header >= 39) return 'p2wpkh';
    if (header >= 35) return 'p2sh';
    if (header >= 31) return 'p2pkh';
    return 'p2pkh';
  })();

  let point;
  try {
    point = secp256k1.Signature.fromCompact(signature.slice(1))
      .addRecoveryBit(recoveryId)
      .recoverPublicKey(bip137MessageHash(message));
  } catch {
    return { error: 'No public key can be recovered from this signature.' };
  }

  return {
    candidates: addressesForPublicKey(point.toBytes(true), point.toBytes(false), network),
    claimedKind,
  };
}
