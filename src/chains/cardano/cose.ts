/**
 * CIP-8 message signatures, which are COSE_Sign1 structures.
 *
 * A wallet returns two hex blobs: the signed structure and the public key that
 * made it. The signature does not cover the structure as transmitted — it
 * covers a `Sig_structure`, a separate CBOR array built from the protected
 * headers and the payload. So verifying means rebuilding those bytes exactly.
 * The protected headers are reused verbatim rather than re-encoded, since a
 * re-encoding that differs by even a byte would compute a different signature
 * over identical-looking data.
 *
 * The payload may be absent — a "detached" signature — in which case it is
 * reconstructed from the message the verifier was given. It may also be a
 * BLAKE2b-224 hash of the message rather than the message itself, which the
 * `hashed` flag in the unprotected headers announces.
 */

import { CborError, decodeCbor, encodeArrayHeader, encodeBytes, encodeText } from '../../lib/cbor.ts';
import { concatBytes } from '../../lib/bytes.ts';

/** COSE's identifier for EdDSA, the only algorithm CIP-8 uses. */
const ALG_EDDSA = -8;
const HEADER_ALG = 1;
const HEADER_ADDRESS = 'address';
const HEADER_HASHED = 'hashed';

/** COSE_Key labels: 1 = kty, 3 = alg, -1 = crv, -2 = x. */
const KEY_TYPE = 1;
const KEY_CURVE = -1;
const KEY_X = -2;
const OKP = 1;
const ED25519 = 6;

export class CoseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoseError';
  }
}

export interface CoseSign1 {
  /** The protected headers exactly as received, reused when signing is checked. */
  protectedRaw: Uint8Array;
  /** The address the signer put in the protected headers, if any. */
  address: Uint8Array | null;
  /** Whether the payload is a hash of the message rather than the message. */
  hashed: boolean;
  /** The embedded payload, or null for a detached signature. */
  payload: Uint8Array | null;
  signature: Uint8Array;
}

function asBytes(value: unknown, what: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new CoseError(`${what} is not a byte string.`);
  return value;
}

export function decodeCoseSign1(bytes: Uint8Array): CoseSign1 {
  let value;
  try {
    value = decodeCbor(bytes);
  } catch (error) {
    throw new CoseError(
      error instanceof CborError ? error.message : 'The signature is not valid CBOR.',
    );
  }

  if (!Array.isArray(value) || value.length !== 4) {
    throw new CoseError('A COSE_Sign1 is a four-element array; this is not one.');
  }
  const [protectedRaw, unprotected, payload, signature] = value;

  const headers = asBytes(protectedRaw, 'The protected headers');
  const protectedMap = headers.length === 0 ? new Map() : decodeCbor(headers);
  if (!(protectedMap instanceof Map)) {
    throw new CoseError('The protected headers are not a CBOR map.');
  }

  const alg = protectedMap.get(HEADER_ALG);
  if (alg !== ALG_EDDSA) {
    throw new CoseError(
      `The signature declares algorithm ${String(alg)}; CIP-8 signatures are EdDSA (-8).`,
    );
  }

  const addressValue = protectedMap.get(HEADER_ADDRESS);
  const address = addressValue instanceof Uint8Array ? addressValue : null;

  const hashed = unprotected instanceof Map && unprotected.get(HEADER_HASHED) === true;

  return {
    protectedRaw: headers,
    address,
    hashed,
    payload: payload === null ? null : asBytes(payload, 'The payload'),
    signature: asBytes(signature, 'The signature'),
  };
}

/** Pulls the ed25519 public key out of the COSE_Key a wallet returns alongside. */
export function decodeCoseKey(bytes: Uint8Array): Uint8Array {
  let value;
  try {
    value = decodeCbor(bytes);
  } catch (error) {
    throw new CoseError(
      error instanceof CborError ? error.message : 'The key is not valid CBOR.',
    );
  }

  if (!(value instanceof Map)) throw new CoseError('A COSE_Key is a CBOR map; this is not one.');

  if (value.get(KEY_TYPE) !== OKP || value.get(KEY_CURVE) !== ED25519) {
    throw new CoseError('The key is not an Ed25519 key.');
  }

  const publicKey = value.get(KEY_X);
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) {
    throw new CoseError('The key does not contain a 32-byte Ed25519 public key.');
  }
  return publicKey;
}

/**
 * The bytes a COSE_Sign1 signature actually covers. `external_aad` is always
 * empty for CIP-8, but it is part of the structure and so part of the hash.
 */
export function sigStructure(protectedRaw: Uint8Array, payload: Uint8Array): Uint8Array {
  return concatBytes(
    encodeArrayHeader(4),
    encodeText('Signature1'),
    encodeBytes(protectedRaw),
    encodeBytes(new Uint8Array(0)),
    encodeBytes(payload),
  );
}
