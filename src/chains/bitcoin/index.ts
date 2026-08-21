import { base64 } from '@scure/base';

import type { ChainAdapter, VerifyInput, VerifyOutcome } from '../types.ts';
import {
  describeAddressKind,
  parseAddress,
  type AddressKind,
  type ParsedAddress,
} from './address.ts';
import { recoverBip137 } from './bip137.ts';
import { splitVariant, verifyBip322Simple } from './bip322.ts';
import { connectBitcoinWallet, listBitcoinWallets } from './wallets.ts';

const SCRIPT_INTERPRETER_HINT =
  'Signatures over multisig or other scripted addresses need a full Bitcoin script ' +
  'interpreter to check. Adding one would not change the offline guarantee, but it is ' +
  'a large amount of consensus-critical code and is not included yet.';

function decodeSignature(raw: string): Uint8Array | null {
  try {
    return base64.decode(raw);
  } catch {
    return null;
  }
}

/** Chooses the address of the same script type for a like-for-like comparison. */
function comparableCandidate(
  candidates: Map<string, AddressKind>,
  kind: AddressKind,
): string | undefined {
  for (const [address, candidateKind] of candidates) {
    if (candidateKind === kind) return address;
  }
  return candidates.keys().next().value;
}

function verifyBip137(
  message: string,
  signature: Uint8Array,
  address: ParsedAddress,
  given: string,
): VerifyOutcome {
  const result = recoverBip137(message, signature, address.network);
  if ('error' in result) return { status: 'invalid', reason: result.error };

  if (result.candidates.has(given)) return { status: 'valid', address: given };

  const recovered = comparableCandidate(result.candidates, address.kind);
  return {
    status: 'invalid',
    reason:
      'The signature is well-formed, but the key that produced it does not control this address.',
    recoveredAddress: recovered,
  };
}

export const bitcoinAdapter: ChainAdapter = {
  id: 'bitcoin',
  name: 'Bitcoin',
  addressPlaceholder: 'bc1… or 1… or 3…',
  signaturePlaceholder: 'Base64 signature',
  signatureEncoding: 'base64',
  signingStandard: 'BIP-137 and BIP-322',
  verifyHint:
    'Base64 signature. Both the legacy BIP-137 format (Bitcoin Core, Electrum, hardware ' +
    'wallets) and BIP-322 are detected automatically.',

  listWallets: listBitcoinWallets,
  connect: connectBitcoinWallet,

  async verify({ address, message, signature }: VerifyInput): Promise<VerifyOutcome> {
    const given = address.trim();
    if (!given) {
      return { status: 'malformed', reason: 'No address provided.', field: 'address' };
    }

    const parsed = parseAddress(given);
    if (!parsed) {
      return {
        status: 'malformed',
        reason:
          'That is not a valid Bitcoin address. Check for a typo — the checksum did not match.',
        field: 'address',
      };
    }
    if (parsed.kind === 'unknown-witness') {
      return {
        status: 'unsupported',
        reason: `This is a witness version ${parsed.witnessVersion} address, a script type that does not exist yet.`,
      };
    }

    const cleaned = signature.trim().replace(/\s+/g, '');
    if (!cleaned) {
      return { status: 'malformed', reason: 'No signature provided.', field: 'signature' };
    }

    const { variant, body } = splitVariant(cleaned);
    if (variant !== 'smp') {
      return {
        status: 'unsupported',
        reason:
          `This signature declares the BIP-322 "${variant}" variant, which wraps a complete ` +
          'transaction. Only the simple variant is supported.',
        hint: SCRIPT_INTERPRETER_HINT,
      };
    }

    const decoded = decodeSignature(body);
    if (!decoded) {
      return {
        status: 'malformed',
        reason: 'The signature is not valid base64.',
        field: 'signature',
      };
    }

    // A 65-byte payload is the legacy recoverable ECDSA format. No BIP-322
    // witness stack for these script types serialises to that length, so the
    // length alone tells the two standards apart.
    const isLegacyLength = decoded.length === 65;
    const legacyCapable =
      parsed.kind === 'p2pkh' || parsed.kind === 'p2sh' || parsed.kind === 'p2wpkh';

    if (isLegacyLength && legacyCapable) {
      return verifyBip137(message, decoded, parsed, given);
    }

    // Some taproot wallets hand back a bare Schnorr signature rather than a
    // one-item witness stack. Accept it by wrapping it the way BIP-322 expects.
    const witness =
      parsed.kind === 'p2tr' && (decoded.length === 64 || decoded.length === 65)
        ? Uint8Array.from([0x01, decoded.length, ...decoded])
        : decoded;

    const outcome = verifyBip322Simple(message, parsed, witness);
    if (outcome.status === 'valid') return { status: 'valid', address: given };
    if (outcome.status === 'unsupported') {
      return { status: 'unsupported', reason: outcome.reason, hint: SCRIPT_INTERPRETER_HINT };
    }

    return {
      status: 'invalid',
      reason: outcome.reason,
      hint:
        `This address is ${describeAddressKind(parsed.kind)}. If the signature came from a ` +
        'different address type belonging to the same wallet, verify against that address instead.',
    };
  },
};
