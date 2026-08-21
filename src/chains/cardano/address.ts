/**
 * Cardano address encoding.
 *
 * A Shelley address is a header byte followed by one or two credentials, each
 * a 28-byte BLAKE2b hash of a key. Which credentials are present depends on the
 * address type: a base address carries both a payment and a staking credential,
 * an enterprise address only the payment one, a reward address only the staking
 * one. Verifying a signature means finding the signing key's hash among them,
 * so all of them have to be enumerable.
 *
 * Note these are bech32 strings well past the 90-character limit bech32
 * nominally imposes — a base address is 103 — which is why the decoder here is
 * given a raised limit rather than the default.
 */

import { blake2b } from '@noble/hashes/blake2b';
import { bech32 } from '@scure/base';

import { bytesEqual } from '../../lib/bytes.ts';

/** Cardano addresses exceed bech32's nominal 90-character limit. */
const BECH32_LIMIT = 1023;
const CREDENTIAL_BYTES = 28;

export type Network = 'mainnet' | 'testnet';

export type AddressKind =
  | 'base'
  | 'pointer'
  | 'enterprise'
  | 'reward'
  | 'byron'
  | 'unknown';

export interface ParsedAddress {
  kind: AddressKind;
  network: Network;
  bytes: Uint8Array;
  /** Every key hash this address commits to, payment first. */
  credentials: Uint8Array[];
  /** True when a credential is a script hash rather than a key hash. */
  hasScript: boolean;
}

/** Cardano hashes keys to 28 bytes, not blake2b's usual 64. */
export function keyHash(publicKey: Uint8Array): Uint8Array {
  return blake2b(publicKey, { dkLen: CREDENTIAL_BYTES });
}

export function hashMessage(message: Uint8Array): Uint8Array {
  return blake2b(message, { dkLen: CREDENTIAL_BYTES });
}

/**
 * The header's high nibble is the address type and its low nibble the network.
 * Types are ordered so that the bits of the high nibble say whether each
 * credential is a script; only the shapes matter here.
 */
function describeType(type: number): { kind: AddressKind; credentialCount: number; hasScript: boolean } {
  switch (type) {
    case 0:
      return { kind: 'base', credentialCount: 2, hasScript: false };
    case 1:
      return { kind: 'base', credentialCount: 2, hasScript: true };
    case 2:
      return { kind: 'base', credentialCount: 2, hasScript: true };
    case 3:
      return { kind: 'base', credentialCount: 2, hasScript: true };
    case 4:
      return { kind: 'pointer', credentialCount: 1, hasScript: false };
    case 5:
      return { kind: 'pointer', credentialCount: 1, hasScript: true };
    case 6:
      return { kind: 'enterprise', credentialCount: 1, hasScript: false };
    case 7:
      return { kind: 'enterprise', credentialCount: 1, hasScript: true };
    case 8:
      return { kind: 'byron', credentialCount: 0, hasScript: false };
    case 14:
      return { kind: 'reward', credentialCount: 1, hasScript: false };
    case 15:
      return { kind: 'reward', credentialCount: 1, hasScript: true };
    default:
      return { kind: 'unknown', credentialCount: 0, hasScript: false };
  }
}

export function parseAddressBytes(bytes: Uint8Array): ParsedAddress | null {
  const header = bytes[0];
  if (header === undefined) return null;

  const { kind, credentialCount, hasScript } = describeType(header >> 4);
  const network: Network = (header & 0x0f) === 1 ? 'mainnet' : 'testnet';

  const credentials: Uint8Array[] = [];
  for (let index = 0; index < credentialCount; index += 1) {
    const start = 1 + index * CREDENTIAL_BYTES;
    const credential = bytes.slice(start, start + CREDENTIAL_BYTES);
    if (credential.length === CREDENTIAL_BYTES) credentials.push(credential);
  }

  return { kind, network, bytes, credentials, hasScript };
}

export function parseAddress(value: string): ParsedAddress | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;

  const decoded = bech32.decodeUnsafe(trimmed as `${string}1${string}`, BECH32_LIMIT);
  if (!decoded) return null;

  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(bech32.fromWords(decoded.words));
  } catch {
    return null;
  }

  const parsed = parseAddressBytes(bytes);
  if (!parsed) return null;

  // The prefix is part of the address's meaning, so a reward address dressed up
  // with an `addr` prefix is not merely cosmetic and is rejected.
  const expected = expectedPrefix(parsed);
  if (expected !== decoded.prefix) return null;
  return parsed;
}

function expectedPrefix(address: ParsedAddress): string {
  const stem = address.kind === 'reward' ? 'stake' : 'addr';
  return address.network === 'mainnet' ? stem : `${stem}_test`;
}

export function encodeAddress(bytes: Uint8Array): string | null {
  const parsed = parseAddressBytes(bytes);
  if (!parsed || parsed.kind === 'byron' || parsed.kind === 'unknown') return null;
  return bech32.encode(expectedPrefix(parsed), bech32.toWords(bytes), BECH32_LIMIT);
}

/** Whether this address is controlled by the key that produced `publicKey`. */
export function addressCommitsToKey(address: ParsedAddress, publicKey: Uint8Array): boolean {
  const hash = keyHash(publicKey);
  return address.credentials.some((credential) => bytesEqual(credential, hash));
}

export function describeAddressKind(kind: AddressKind): string {
  switch (kind) {
    case 'base':
      return 'base address';
    case 'pointer':
      return 'pointer address';
    case 'enterprise':
      return 'enterprise address';
    case 'reward':
      return 'reward (stake) address';
    case 'byron':
      return 'Byron-era address';
    case 'unknown':
      return 'unrecognised address type';
  }
}
