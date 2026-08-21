import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';

import {
  bytesEqual,
  concatBytes,
  uint32LE,
  uint64LE,
  varBytes,
  varInt,
} from '../../lib/bytes.ts';
import { hash160, sha256d, type ParsedAddress } from './address.ts';

/**
 * BIP-322 — the modern scheme, finalised as 1.0.0 in April 2026.
 *
 * Instead of hashing the message directly, BIP-322 builds two virtual
 * transactions: a `to_spend` that pays to the address and commits to the
 * message, and a `to_sign` that spends it. The "signature" is the witness
 * stack that satisfies `to_spend`'s script. Neither transaction is valid on
 * any network — `to_spend` spends a prevout that cannot exist — so nothing
 * here can be broadcast.
 *
 * Only the *simple* variant with single-key scripts is implemented. Anything
 * needing a full script interpreter is reported as unsupported rather than
 * guessed at.
 */

export type Bip322Variant = 'smp' | 'ful' | 'pof';

const OP_RETURN = Uint8Array.of(0x6a);
const SIGHASH_ALL = 1;

function taggedHash(tag: string, data: Uint8Array): Uint8Array {
  const tagHash = sha256(new TextEncoder().encode(tag));
  return sha256(concatBytes(tagHash, tagHash, data));
}

export function bip322MessageHash(message: string): Uint8Array {
  return taggedHash('BIP0322-signed-message', new TextEncoder().encode(message));
}

/**
 * Splits the human-readable variant prefix introduced in BIP-322 1.0.0.
 * Signatures produced before finalisation have no prefix and are simple.
 */
export function splitVariant(signature: string): { variant: Bip322Variant; body: string } {
  for (const variant of ['smp', 'ful', 'pof'] as const) {
    if (signature.startsWith(variant)) return { variant, body: signature.slice(3) };
  }
  return { variant: 'smp', body: signature };
}

/** The virtual transaction that "receives" the message. */
function buildToSpend(messageHash: Uint8Array, scriptPubKey: Uint8Array): Uint8Array {
  const scriptSig = concatBytes(Uint8Array.of(0x00, 0x20), messageHash);
  return concatBytes(
    uint32LE(0), // nVersion
    varInt(1), // input count
    new Uint8Array(32), // prevout hash: all zeroes
    uint32LE(0xffffffff), // prevout index: no such output can exist
    varBytes(scriptSig),
    uint32LE(0), // nSequence
    varInt(1), // output count
    uint64LE(0),
    varBytes(scriptPubKey),
    uint32LE(0), // nLockTime
  );
}

/** BIP-143 sighash for the single P2WPKH input of `to_sign`. */
function sighashSegwitV0(toSpendTxid: Uint8Array, publicKeyHash: Uint8Array): Uint8Array {
  const outpoint = concatBytes(toSpendTxid, uint32LE(0));
  const outputs = concatBytes(uint64LE(0), varBytes(OP_RETURN));
  // scriptCode for P2WPKH is the equivalent P2PKH script, length-prefixed.
  const scriptCode = concatBytes(
    Uint8Array.of(0x19, 0x76, 0xa9, 0x14),
    publicKeyHash,
    Uint8Array.of(0x88, 0xac),
  );

  return sha256d(
    concatBytes(
      uint32LE(0), // nVersion
      sha256d(outpoint), // hashPrevouts
      sha256d(uint32LE(0)), // hashSequence
      outpoint,
      scriptCode,
      uint64LE(0), // amount
      uint32LE(0), // nSequence
      sha256d(outputs), // hashOutputs
      uint32LE(0), // nLockTime
      uint32LE(SIGHASH_ALL),
    ),
  );
}

/** BIP-341 sighash for the single key-path P2TR input of `to_sign`. */
function sighashTaproot(toSpendTxid: Uint8Array, scriptPubKey: Uint8Array): Uint8Array {
  const sigMsg = concatBytes(
    Uint8Array.of(0x00), // hash_type: SIGHASH_DEFAULT
    uint32LE(0), // nVersion
    uint32LE(0), // nLockTime
    sha256(concatBytes(toSpendTxid, uint32LE(0))), // sha_prevouts
    sha256(uint64LE(0)), // sha_amounts
    sha256(varBytes(scriptPubKey)), // sha_scriptpubkeys
    sha256(uint32LE(0)), // sha_sequences
    sha256(concatBytes(uint64LE(0), varBytes(OP_RETURN))), // sha_outputs
    Uint8Array.of(0x00), // spend_type: key path, no annex
    uint32LE(0), // input index
  );
  // The leading epoch byte is outside SigMsg but inside the tagged hash.
  return taggedHash('TapSighash', concatBytes(Uint8Array.of(0x00), sigMsg));
}

function parseWitnessStack(bytes: Uint8Array): Uint8Array[] | null {
  let offset = 0;

  const readCompactSize = (): number | null => {
    const first = bytes[offset];
    if (first === undefined) return null;
    offset += 1;
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      if (offset + 2 > bytes.length) return null;
      const value = (bytes[offset] as number) | ((bytes[offset + 1] as number) << 8);
      offset += 2;
      return value;
    }
    return null; // Larger sizes cannot occur in a message-signing witness.
  };

  const count = readCompactSize();
  if (count === null || count > 100) return null;

  const stack: Uint8Array[] = [];
  for (let i = 0; i < count; i += 1) {
    const length = readCompactSize();
    if (length === null || offset + length > bytes.length) return null;
    stack.push(bytes.slice(offset, offset + length));
    offset += length;
  }

  // Trailing bytes mean this is not a bare witness stack — very likely a full
  // transaction mislabelled as simple. Refuse rather than verify part of it.
  if (offset !== bytes.length) return null;
  return stack;
}

export type Bip322Outcome =
  | { status: 'valid' }
  | { status: 'invalid'; reason: string }
  | { status: 'unsupported'; reason: string };

export function verifyBip322Simple(
  message: string,
  address: ParsedAddress,
  witnessBytes: Uint8Array,
): Bip322Outcome {
  const stack = parseWitnessStack(witnessBytes);
  if (!stack) {
    return { status: 'invalid', reason: 'The signature is not a well-formed witness stack.' };
  }

  const toSpendTxid = sha256d(buildToSpend(bip322MessageHash(message), address.script));

  if (address.kind === 'p2wpkh') {
    if (stack.length !== 2) {
      return {
        status: 'invalid',
        reason: `A P2WPKH witness holds a signature and a public key; this one has ${stack.length} item(s).`,
      };
    }
    const [derSignature, publicKey] = stack as [Uint8Array, Uint8Array];
    if (publicKey.length !== 33 || !bytesEqual(hash160(publicKey), address.payload)) {
      return {
        status: 'invalid',
        reason: 'The public key in the signature does not hash to this address.',
      };
    }
    if (derSignature.length < 9) {
      return { status: 'invalid', reason: 'The embedded ECDSA signature is truncated.' };
    }
    const sighashType = derSignature[derSignature.length - 1] as number;
    if (sighashType !== SIGHASH_ALL) {
      return {
        status: 'invalid',
        reason: `The signature commits to sighash type ${sighashType}; BIP-322 requires SIGHASH_ALL.`,
      };
    }

    let ok: boolean;
    try {
      // fromDER enforces BIP-322's STRICTENC rule; anything sloppily encoded
      // throws here rather than being silently accepted.
      const parsed = secp256k1.Signature.fromDER(derSignature.slice(0, -1));
      ok = secp256k1.verify(
        parsed.toBytes('compact'),
        sighashSegwitV0(toSpendTxid, address.payload),
        publicKey,
        // BIP-322 requires LOW_S; a high-S signature is malleable and invalid.
        { lowS: true },
      );
    } catch {
      return { status: 'invalid', reason: 'The embedded ECDSA signature is malformed.' };
    }
    return ok
      ? { status: 'valid' }
      : { status: 'invalid', reason: 'The signature does not match this message and address.' };
  }

  if (address.kind === 'p2tr') {
    if (stack.length !== 1) {
      return {
        status: 'unsupported',
        reason:
          'This taproot signature spends by script path, which needs a full script interpreter.',
      };
    }
    const signature = stack[0] as Uint8Array;
    if (signature.length !== 64 && signature.length !== 65) {
      return {
        status: 'invalid',
        reason: `A Schnorr signature is 64 bytes (65 with a sighash flag); this one is ${signature.length}.`,
      };
    }
    if (signature.length === 65 && signature[64] !== SIGHASH_ALL) {
      return {
        status: 'invalid',
        reason: `The signature commits to sighash type ${signature[64]}; BIP-322 allows only SIGHASH_DEFAULT or SIGHASH_ALL.`,
      };
    }

    let ok: boolean;
    try {
      ok = schnorr.verify(
        signature.slice(0, 64),
        sighashTaproot(toSpendTxid, address.script),
        address.payload,
      );
    } catch {
      return { status: 'invalid', reason: 'The Schnorr signature is malformed.' };
    }
    return ok
      ? { status: 'valid' }
      : { status: 'invalid', reason: 'The signature does not match this message and address.' };
  }

  return {
    status: 'unsupported',
    reason:
      'This address pays to a script (multisig or similar). Checking it needs a full Bitcoin ' +
      'script interpreter, which this tool does not include.',
  };
}
