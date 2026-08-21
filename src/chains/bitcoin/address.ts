import { ripemd160 } from '@noble/hashes/legacy';
import { sha256 } from '@noble/hashes/sha2';
import { base58check, bech32, bech32m } from '@scure/base';

import { concatBytes } from '../../lib/bytes.ts';

/**
 * Bitcoin address encoding and script derivation.
 *
 * Bitcoin has no single address format: the same key yields a different string
 * for each script type, and message-signing standards care which one you used.
 * Everything needed to go address → script and key → address lives here.
 */

const base58Check = base58check(sha256);

export type AddressKind = 'p2pkh' | 'p2sh' | 'p2wpkh' | 'p2wsh' | 'p2tr' | 'unknown-witness';
export type Network = 'mainnet' | 'testnet';

export interface ParsedAddress {
  kind: AddressKind;
  network: Network;
  /** The scriptPubKey this address pays to. */
  script: Uint8Array;
  /** Witness program for segwit addresses, hash160/sha256 payload otherwise. */
  payload: Uint8Array;
  /** Segwit witness version, or -1 for legacy base58 addresses. */
  witnessVersion: number;
}

export function hash160(bytes: Uint8Array): Uint8Array {
  return ripemd160(sha256(bytes));
}

export function sha256d(bytes: Uint8Array): Uint8Array {
  return sha256(sha256(bytes));
}

const P2PKH_VERSION = { mainnet: 0x00, testnet: 0x6f } as const;
const P2SH_VERSION = { mainnet: 0x05, testnet: 0xc4 } as const;
const HRP = { mainnet: 'bc', testnet: 'tb' } as const;

function parseBech32(address: string): ParsedAddress | null {
  const lower = address.toLowerCase();
  const network: Network | null = lower.startsWith('bc1')
    ? 'mainnet'
    : lower.startsWith('tb1') || lower.startsWith('bcrt1')
      ? 'testnet'
      : null;
  if (!network) return null;

  const decoded = bech32.decodeUnsafe(lower) ?? bech32m.decodeUnsafe(lower);
  if (!decoded) return null;

  const words = decoded.words;
  const version = words[0];
  if (version === undefined || version > 16) return null;

  // The checksum algorithm is part of the address's meaning: witness v0 uses
  // bech32 and v1+ uses bech32m. A v0 string that only validates under bech32m
  // is not a valid address, so re-check under the variant the version demands.
  const strict = version === 0 ? bech32.decodeUnsafe(lower) : bech32m.decodeUnsafe(lower);
  if (!strict) return null;

  let program: Uint8Array;
  try {
    program = Uint8Array.from(bech32.fromWords(words.slice(1)));
  } catch {
    return null;
  }
  if (program.length < 2 || program.length > 40) return null;
  if (version === 0 && program.length !== 20 && program.length !== 32) return null;

  const opcode = version === 0 ? 0x00 : 0x50 + version;
  const script = concatBytes(Uint8Array.of(opcode, program.length), program);

  const kind: AddressKind =
    version === 0 && program.length === 20
      ? 'p2wpkh'
      : version === 0 && program.length === 32
        ? 'p2wsh'
        : version === 1 && program.length === 32
          ? 'p2tr'
          : 'unknown-witness';

  return { kind, network, script, payload: program, witnessVersion: version };
}

function parseBase58(address: string): ParsedAddress | null {
  let payload: Uint8Array;
  try {
    payload = base58Check.decode(address);
  } catch {
    return null;
  }
  if (payload.length !== 21) return null;

  const version = payload[0] as number;
  const hash = payload.slice(1);

  if (version === P2PKH_VERSION.mainnet || version === P2PKH_VERSION.testnet) {
    return {
      kind: 'p2pkh',
      network: version === P2PKH_VERSION.mainnet ? 'mainnet' : 'testnet',
      // OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG
      script: concatBytes(Uint8Array.of(0x76, 0xa9, 0x14), hash, Uint8Array.of(0x88, 0xac)),
      payload: hash,
      witnessVersion: -1,
    };
  }

  if (version === P2SH_VERSION.mainnet || version === P2SH_VERSION.testnet) {
    return {
      kind: 'p2sh',
      network: version === P2SH_VERSION.mainnet ? 'mainnet' : 'testnet',
      // OP_HASH160 <20> OP_EQUAL
      script: concatBytes(Uint8Array.of(0xa9, 0x14), hash, Uint8Array.of(0x87)),
      payload: hash,
      witnessVersion: -1,
    };
  }

  return null;
}

export function parseAddress(address: string): ParsedAddress | null {
  const trimmed = address.trim();
  if (!trimmed) return null;
  return parseBech32(trimmed) ?? parseBase58(trimmed);
}

export function encodeP2pkh(publicKey: Uint8Array, network: Network): string {
  return base58Check.encode(concatBytes(Uint8Array.of(P2PKH_VERSION[network]), hash160(publicKey)));
}

/** P2SH-wrapped P2WPKH: the "3…" addresses that segwit shipped with. */
export function encodeP2shP2wpkh(publicKey: Uint8Array, network: Network): string {
  const redeemScript = concatBytes(Uint8Array.of(0x00, 0x14), hash160(publicKey));
  return base58Check.encode(
    concatBytes(Uint8Array.of(P2SH_VERSION[network]), hash160(redeemScript)),
  );
}

export function encodeP2wpkh(publicKey: Uint8Array, network: Network): string {
  return bech32.encode(HRP[network], [0, ...bech32.toWords(hash160(publicKey))]);
}

/** Every address a single public key can produce, for both key encodings. */
export function addressesForPublicKey(
  compressed: Uint8Array,
  uncompressed: Uint8Array,
  network: Network,
): Map<string, AddressKind> {
  return new Map<string, AddressKind>([
    [encodeP2pkh(compressed, network), 'p2pkh'],
    [encodeP2pkh(uncompressed, network), 'p2pkh'],
    [encodeP2shP2wpkh(compressed, network), 'p2sh'],
    [encodeP2wpkh(compressed, network), 'p2wpkh'],
  ]);
}

export function describeAddressKind(kind: AddressKind): string {
  switch (kind) {
    case 'p2pkh':
      return 'legacy (P2PKH)';
    case 'p2sh':
      return 'nested segwit (P2SH)';
    case 'p2wpkh':
      return 'native segwit (P2WPKH)';
    case 'p2wsh':
      return 'native segwit script (P2WSH)';
    case 'p2tr':
      return 'taproot (P2TR)';
    case 'unknown-witness':
      return 'future segwit version';
  }
}
