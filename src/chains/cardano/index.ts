import { ed25519 } from '@noble/curves/ed25519';

import { bytesEqual, hexToBytes } from '../../lib/bytes.ts';
import type { ChainAdapter, Connection, VerifyInput, VerifyOutcome, WalletOption } from '../types.ts';
import {
  addressCommitsToKey,
  describeAddressKind,
  encodeAddress,
  hashMessage,
  parseAddress,
} from './address.ts';
import { CoseError, decodeCoseKey, decodeCoseSign1, sigStructure } from './cose.ts';
import { connectCardanoWallet, listCardanoWallets } from './wallets.ts';

const VERIFY_HINT =
  'Paste what the wallet returned: the CIP-30 object with its "signature" and "key" ' +
  'fields, or just the two hex strings separated by a space. Both halves are needed — ' +
  'a Cardano address is a hash of the key, so the key cannot be recovered from the ' +
  'signature alone.';

interface SignaturePair {
  signature: Uint8Array;
  key: Uint8Array;
}

/**
 * Wallets hand back `{ signature, key }`, and that object pasted verbatim is
 * the most likely thing to arrive here. Two bare hex strings are accepted too,
 * since that is what someone reading the two fields separately would produce.
 */
function parseSignaturePair(raw: string): SignaturePair | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { error: 'No signature provided.' };

  if (trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { error: 'That looks like JSON but does not parse.' };
    }
    const object = parsed as { signature?: unknown; key?: unknown };
    if (typeof object.signature !== 'string' || typeof object.key !== 'string') {
      return { error: 'The JSON needs both a "signature" and a "key" field.' };
    }
    return decodePair(object.signature, object.key);
  }

  const parts = trimmed.split(/[\s,]+/).filter(Boolean);
  if (parts.length !== 2) {
    return {
      error:
        parts.length < 2
          ? 'A Cardano signature has two parts: the COSE_Sign1 and the public key.'
          : `Expected two hex values, found ${parts.length}.`,
    };
  }
  return decodePair(parts[0] as string, parts[1] as string);
}

function decodePair(signature: string, key: string): SignaturePair | { error: string } {
  const signatureBytes = hexToBytes(signature.trim());
  if (!signatureBytes) return { error: 'The signature is not valid hex.' };
  const keyBytes = hexToBytes(key.trim());
  if (!keyBytes) return { error: 'The public key is not valid hex.' };
  return { signature: signatureBytes, key: keyBytes };
}

export const cardanoAdapter: ChainAdapter = {
  id: 'cardano',
  name: 'Cardano',
  addressPlaceholder: 'addr1… or stake1…',
  signaturePlaceholder: '{ "signature": "84…", "key": "a4…" }',
  signatureEncoding: 'CIP-30 signature and key, hex',
  signingStandard: 'CIP-8 COSE_Sign1 over CIP-30 wallets',
  verifyHint: VERIFY_HINT,

  async listWallets(): Promise<WalletOption[]> {
    return listCardanoWallets();
  },

  async connect(walletId: string): Promise<Connection> {
    return connectCardanoWallet(walletId);
  },

  async verify({ address, message, signature }: VerifyInput): Promise<VerifyOutcome> {
    const claimed = address.trim();
    if (!claimed) {
      return { status: 'malformed', reason: 'No address provided.', field: 'address' };
    }

    const parsedAddress = parseAddress(claimed);
    if (!parsedAddress) {
      return {
        status: 'malformed',
        reason:
          'That is not a valid Cardano address. Shelley addresses are bech32 and begin ' +
          'with addr1, addr_test1, stake1 or stake_test1.',
        field: 'address',
      };
    }
    if (parsedAddress.kind === 'byron') {
      return {
        status: 'unsupported',
        reason: 'Byron-era addresses are not supported; they predate CIP-8 message signing.',
      };
    }

    const pair = parseSignaturePair(signature);
    if ('error' in pair) {
      return { status: 'malformed', reason: pair.error, field: 'signature' };
    }

    let sign1;
    let publicKey: Uint8Array;
    try {
      sign1 = decodeCoseSign1(pair.signature);
      publicKey = decodeCoseKey(pair.key);
    } catch (error) {
      return {
        status: 'malformed',
        reason: error instanceof CoseError ? error.message : 'The signature is not a CIP-8 structure.',
        field: 'signature',
      };
    }

    if (sign1.signature.length !== 64) {
      return {
        status: 'malformed',
        reason: `The signature is ${sign1.signature.length} bytes; an Ed25519 signature is 64.`,
        field: 'signature',
      };
    }

    // A script-controlled address is not spent by a key at all, so no
    // single-key signature can ever prove control of one.
    if (parsedAddress.hasScript) {
      return {
        status: 'unsupported',
        reason:
          `This is a script-controlled ${describeAddressKind(parsedAddress.kind)}. Control of it ` +
          'is decided by a script the ledger evaluates, not by one key signing a message.',
      };
    }

    const messageBytes = new TextEncoder().encode(message);
    const expectedPayload = sign1.hashed ? hashMessage(messageBytes) : messageBytes;

    // A detached signature omits the payload, so the verifier supplies it. If
    // the message is wrong the reconstruction is wrong and the maths fails,
    // which is exactly the check we want.
    if (sign1.payload !== null && !bytesEqual(sign1.payload, expectedPayload)) {
      return {
        status: 'invalid',
        reason: sign1.hashed
          ? 'The signature commits to the hash of a different message.'
          : 'The signature carries a different message from the one given here.',
        hint: 'Messages must match exactly, including whitespace and line endings.',
      };
    }

    let signatureValid: boolean;
    try {
      signatureValid = ed25519.verify(
        sign1.signature,
        sigStructure(sign1.protectedRaw, expectedPayload),
        publicKey,
      );
    } catch {
      signatureValid = false;
    }

    if (!signatureValid) {
      return {
        status: 'invalid',
        reason:
          'The signature does not match this message and key. Either it was made over ' +
          'something else, or the key given is not the one that signed.',
      };
    }

    // The address in the protected headers is signed, but the signer chose it.
    // Believing it on its own would let anyone claim any address, so the key
    // must independently hash to one of the address's credentials.
    if (!addressCommitsToKey(parsedAddress, publicKey)) {
      const signedFor = sign1.address ? encodeAddress(sign1.address) : null;
      return {
        status: 'invalid',
        reason:
          'The signature is genuine, but the key that made it does not control this address.',
        recoveredAddress: signedFor ?? undefined,
        hint:
          'A Cardano address is a hash of its key, and this key hashes to something else — ' +
          'so this proof belongs to a different address.',
      };
    }

    if (sign1.address && !bytesEqual(sign1.address, parsedAddress.bytes)) {
      const signedFor = encodeAddress(sign1.address);
      return {
        status: 'invalid',
        reason: 'This proof was made for a different address, though the same key controls both.',
        recoveredAddress: signedFor ?? undefined,
        hint: 'The address is signed into the message, so a proof is only good for the one named.',
      };
    }

    return { status: 'valid', address: claimed };
  },
};
