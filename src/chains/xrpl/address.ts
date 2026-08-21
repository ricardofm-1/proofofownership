/**
 * XRP Ledger address encoding.
 *
 * An XRPL address is a base58check-encoded hash of a public key, using an
 * alphabet of Ripple's own — the same bytes encode to a different string than
 * they would on Bitcoin. Because the address is a hash, it cannot be worked
 * backwards to the key that made it, which is what forces this tool to take a
 * whole signed transaction rather than a bare signature: the transaction is
 * where the public key is published.
 */

import { ripemd160 } from '@noble/hashes/legacy';
import { sha256 } from '@noble/hashes/sha2';
import { base58xrp } from '@scure/base';

import { bytesEqual, concatBytes } from '../../lib/bytes.ts';

const ACCOUNT_ID_BYTES = 20;
const CLASSIC_ADDRESS_PREFIX = 0x00;
/** Tagged "X-addresses" carry a destination tag alongside the account. */
const X_ADDRESS_PREFIX = { mainnet: [0x05, 0x44], testnet: [0x04, 0x93] } as const;

export type KeyType = 'secp256k1' | 'ed25519';

function checksum(payload: Uint8Array): Uint8Array {
  return sha256(sha256(payload)).slice(0, 4);
}

function encodeBase58Check(payload: Uint8Array): string {
  return base58xrp.encode(concatBytes(payload, checksum(payload)));
}

function decodeBase58Check(value: string): Uint8Array | null {
  let decoded: Uint8Array;
  try {
    decoded = base58xrp.decode(value);
  } catch {
    return null;
  }
  if (decoded.length < 5) return null;

  const payload = decoded.slice(0, -4);
  if (!bytesEqual(decoded.slice(-4), checksum(payload))) return null;
  return payload;
}

export function accountIdToAddress(accountId: Uint8Array): string {
  return encodeBase58Check(concatBytes(Uint8Array.of(CLASSIC_ADDRESS_PREFIX), accountId));
}

/** The account a public key controls: RIPEMD-160 of its SHA-256. */
export function accountIdFromPublicKey(publicKey: Uint8Array): Uint8Array {
  return ripemd160(sha256(publicKey));
}

export function addressFromPublicKey(publicKey: Uint8Array): string {
  return accountIdToAddress(accountIdFromPublicKey(publicKey));
}

/**
 * Accepts a classic `r…` address, or an `X…`/`T…` tagged address whose account
 * half is what matters here.
 */
export function addressToAccountId(address: string): Uint8Array | null {
  const payload = decodeBase58Check(address.trim());
  if (!payload) return null;

  if (payload.length === ACCOUNT_ID_BYTES + 1 && payload[0] === CLASSIC_ADDRESS_PREFIX) {
    return payload.slice(1);
  }

  for (const prefix of [X_ADDRESS_PREFIX.mainnet, X_ADDRESS_PREFIX.testnet]) {
    if (payload.length === ACCOUNT_ID_BYTES + 2 + 9) {
      const [first, second] = prefix;
      if (payload[0] === first && payload[1] === second) return payload.slice(2, 2 + ACCOUNT_ID_BYTES);
    }
  }

  return null;
}

/**
 * XRPL public keys are always 33 bytes. secp256k1 keys are compressed points
 * marked 0x02 or 0x03; ed25519 keys are 32 bytes padded to a common width by a
 * leading 0xED, which exists purely so the two can be told apart on sight.
 */
export function classifyPublicKey(publicKey: Uint8Array): KeyType | null {
  if (publicKey.length !== 33) return null;
  const prefix = publicKey[0];
  if (prefix === 0xed) return 'ed25519';
  if (prefix === 0x02 || prefix === 0x03) return 'secp256k1';
  return null;
}
