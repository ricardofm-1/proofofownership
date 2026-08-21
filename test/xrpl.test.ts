import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { describe } from 'node:test';

import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha512 } from '@noble/hashes/sha2';

import { xrplAdapter } from '../src/chains/xrpl/index.ts';
import { addressFromPublicKey, addressToAccountId } from '../src/chains/xrpl/address.ts';
import { parseFields, singleSigningData } from '../src/chains/xrpl/binary.ts';
import { inspectSignedTransaction } from '../src/chains/xrpl/proof.ts';
import { bytesToHex, concatBytes, hexToBytes } from '../src/lib/bytes.ts';

/**
 * Two kinds of evidence, deliberately kept apart.
 *
 * The cryptography is pinned by real mainnet transactions: each one was
 * accepted into a validated ledger, so XRPL consensus had already ruled its
 * signature good. Nothing in this repository produced them, so they cannot
 * agree with a mistake of ours.
 *
 * The plumbing around it — memo extraction, address matching, the verdicts the
 * adapter returns — is exercised with transactions built and signed here. That
 * is only safe because the signing hash those tests rely on is the same one the
 * mainnet vectors above already hold to account.
 */

interface MainnetVectors {
  ledger_index: number;
  transactions: { transactionType: string; keyType: string; account: string; blob: string }[];
}

const mainnet = JSON.parse(
  readFileSync(new URL('./vectors/xrpl-mainnet.json', import.meta.url), 'utf8'),
) as MainnetVectors;

describe('XRPL signatures from a validated mainnet ledger', () => {
  test('the fixture covers both signing algorithms', () => {
    const kinds = new Set(mainnet.transactions.map((t) => t.keyType));
    assert.deepEqual([...kinds].sort(), ['ed25519', 'secp256k1']);
    assert.ok(mainnet.transactions.length >= 20);
  });

  for (const [index, vector] of mainnet.transactions.entries()) {
    test(`${index} ${vector.transactionType} (${vector.keyType}) verifies`, () => {
      const proof = inspectSignedTransaction(hexToBytes(vector.blob) as Uint8Array);
      assert.equal(proof.kind, 'single');
      if (proof.kind !== 'single') return;

      assert.equal(proof.signatureValid, true);
      assert.equal(proof.keyType, vector.keyType);
      assert.equal(proof.account, vector.account);
      // The signing key hashes to the account it signed for.
      assert.equal(proof.signer, vector.account);
    });
  }

  test('parsing round-trips byte for byte', () => {
    for (const vector of mainnet.transactions) {
      const bytes = hexToBytes(vector.blob) as Uint8Array;
      const rebuilt = concatBytes(...parseFields(bytes).map((field) => field.raw));
      assert.equal(bytesToHex(rebuilt), bytesToHex(bytes));
    }
  });

  test('a single flipped byte in the signed payload is rejected', () => {
    for (const vector of mainnet.transactions.slice(0, 8)) {
      const bytes = hexToBytes(vector.blob) as Uint8Array;
      const fields = parseFields(bytes);
      // The account field is covered by the signature, so altering it must break.
      const account = fields.find((field) => field.key === '8:1');
      assert.ok(account);
      const target = bytes.indexOf(account.value[0] as number, 0);
      const tampered = bytes.slice();
      tampered[target] = ((tampered[target] as number) ^ 0xff) & 0xff;

      const proof = inspectSignedTransaction(tampered);
      if (proof.kind === 'single') assert.equal(proof.signatureValid, false);
    }
  });

  test('the signing payload carries rippled’s transaction prefix', () => {
    const first = mainnet.transactions[0];
    assert.ok(first);
    const signed = singleSigningData(parseFields(hexToBytes(first.blob) as Uint8Array));
    assert.equal(bytesToHex(signed.slice(0, 4)), '53545800');
  });

  test('the signature itself is excluded from what it signs', () => {
    const first = mainnet.transactions[0];
    assert.ok(first);
    const bytes = hexToBytes(first.blob) as Uint8Array;
    const fields = parseFields(bytes);
    const signature = fields.find((field) => field.key === '7:4');
    assert.ok(signature);
    const signed = bytesToHex(singleSigningData(fields));
    assert.ok(!signed.includes(bytesToHex(signature.value)));
  });
});

describe('XRPL addresses', () => {
  test('a public key derives to the account that signed with it', () => {
    for (const vector of mainnet.transactions) {
      const fields = parseFields(hexToBytes(vector.blob) as Uint8Array);
      const key = fields.find((field) => field.key === '7:3');
      assert.ok(key);
      assert.equal(addressFromPublicKey(key.value), vector.account);
    }
  });

  test('a corrupted address fails its checksum', () => {
    const good = mainnet.transactions[0]?.account as string;
    assert.ok(addressToAccountId(good));
    const swapped = good.slice(0, -1) + (good.endsWith('a') ? 'b' : 'a');
    assert.equal(addressToAccountId(swapped), null);
  });

  test('Bitcoin and XRPL alphabets are not interchangeable', () => {
    // "1" is valid base58 on Bitcoin but absent from Ripple's alphabet.
    assert.equal(addressToAccountId('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'), null);
  });
});

// --- Locally built proofs, for the paths mainnet data cannot reach ----------

const sha512Half = (bytes: Uint8Array): Uint8Array => sha512(bytes).slice(0, 32);

function variableLength(length: number): Uint8Array {
  if (length <= 192) return Uint8Array.of(length);
  if (length <= 12480) {
    const value = length - 193;
    return Uint8Array.of(193 + (value >> 8), value & 0xff);
  }
  throw new Error('test fixtures stay small');
}

function header(typeCode: number, fieldCode: number): Uint8Array {
  if (typeCode < 16 && fieldCode < 16) return Uint8Array.of((typeCode << 4) | fieldCode);
  if (typeCode < 16) return Uint8Array.of(typeCode << 4, fieldCode);
  if (fieldCode < 16) return Uint8Array.of(fieldCode, typeCode);
  return Uint8Array.of(0, typeCode, fieldCode);
}

const blob = (t: number, f: number, value: Uint8Array) =>
  concatBytes(header(t, f), variableLength(value.length), value);
const fixed = (t: number, f: number, value: Uint8Array) => concatBytes(header(t, f), value);
const uint16 = (f: number, value: number) => fixed(1, f, Uint8Array.of(value >> 8, value & 0xff));
const uint32 = (f: number, value: number) =>
  fixed(2, f, Uint8Array.of(value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff));

const utf8 = (value: string) => new TextEncoder().encode(value);

/** Serialises the same AccountSet-with-a-memo shape the wallet flow asks for. */
function buildUnsigned(accountId: Uint8Array, publicKey: Uint8Array, message: string): Uint8Array {
  const memo = concatBytes(
    header(14, 10), // Memo
    blob(7, 12, utf8('proof-of-ownership')), // MemoType
    blob(7, 13, utf8(message)), // MemoData
    blob(7, 14, utf8('text/plain')), // MemoFormat
    header(14, 1), // ObjectEndMarker
  );

  // Canonical order is by type code, then field code.
  return concatBytes(
    uint16(2, 3), // TransactionType: AccountSet
    uint32(2, 0), // Flags
    uint32(4, 0), // Sequence
    uint32(27, 0), // LastLedgerSequence
    fixed(6, 8, hexToBytes('4000000000000000') as Uint8Array), // Fee: 0 drops
    blob(7, 3, publicKey), // SigningPubKey
    blob(8, 1, accountId), // Account
    concatBytes(header(15, 9), memo, header(15, 1)), // Memos
  );
}

/** Splices the signature in at its canonical position, right after the key. */
function withSignature(unsigned: Uint8Array, signature: Uint8Array): Uint8Array {
  const fields = parseFields(unsigned);
  const out: Uint8Array[] = [];
  for (const field of fields) {
    out.push(field.raw);
    if (field.key === '7:3') out.push(blob(7, 4, signature));
  }
  return concatBytes(...out);
}

const ED_KEY = hexToBytes('9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0') as Uint8Array;
const EC_KEY = hexToBytes('1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809') as Uint8Array;

function signProof(
  keyType: 'ed25519' | 'secp256k1',
  message: string,
  options: { accountId?: Uint8Array } = {},
): { blob: string; address: string } {
  const publicKey =
    keyType === 'ed25519'
      ? concatBytes(Uint8Array.of(0xed), ed25519.getPublicKey(ED_KEY))
      : secp256k1.getPublicKey(EC_KEY, true);

  const address = addressFromPublicKey(publicKey);
  const accountId = options.accountId ?? (addressToAccountId(address) as Uint8Array);

  const unsigned = buildUnsigned(accountId, publicKey, message);
  const payload = singleSigningData(parseFields(unsigned));
  const signature =
    keyType === 'ed25519'
      ? ed25519.sign(payload, ED_KEY)
      : secp256k1.sign(sha512Half(payload), EC_KEY).toBytes('der');

  return { blob: bytesToHex(withSignature(unsigned, signature)), address };
}

describe('XRPL proof verification', () => {
  const message = 'I control this account.\nLine two, with trailing space. ';

  for (const keyType of ['ed25519', 'secp256k1'] as const) {
    test(`${keyType}: a matching proof is valid`, async () => {
      const { blob: signed, address } = signProof(keyType, message);
      const outcome = await xrplAdapter.verify({ address, message, signature: signed });
      assert.equal(outcome.status, 'valid');
    });

    test(`${keyType}: a different message is rejected`, async () => {
      const { blob: signed, address } = signProof(keyType, message);
      const outcome = await xrplAdapter.verify({
        address,
        message: `${message}!`,
        signature: signed,
      });
      assert.equal(outcome.status, 'invalid');
      assert.match(outcome.status === 'invalid' ? outcome.reason : '', /message/i);
    });

    test(`${keyType}: a tampered signature is rejected`, async () => {
      const { blob: signed, address } = signProof(keyType, message);
      const bytes = hexToBytes(signed) as Uint8Array;
      // Flip the last byte of the signature itself, leaving the surrounding
      // transaction structure intact so this tests the maths, not the parser.
      const fields = parseFields(bytes);
      let end = 0;
      for (const field of fields) {
        end += field.raw.length;
        if (field.key === '7:4') break;
      }
      const at = end - 1;
      bytes[at] = ((bytes[at] as number) ^ 0x01) & 0xff;
      const outcome = await xrplAdapter.verify({
        address,
        message,
        signature: bytesToHex(bytes),
      });
      assert.equal(outcome.status, 'invalid');
    });
  }

  test('a proof for another account names the account it really belongs to', async () => {
    const { blob: signed, address } = signProof('ed25519', message);
    const other = mainnet.transactions[0]?.account as string;
    const outcome = await xrplAdapter.verify({ address: other, message, signature: signed });
    assert.equal(outcome.status, 'invalid');
    assert.equal(outcome.status === 'invalid' ? outcome.recoveredAddress : null, address);
  });

  test('a key that is not the account’s own is not ruled on', async () => {
    // Signed correctly, but for an account the key does not derive to — which is
    // what an authorised regular key looks like without the ledger to confirm it.
    const stranger = addressToAccountId(mainnet.transactions[0]?.account as string) as Uint8Array;
    const { blob: signed } = signProof('ed25519', message, { accountId: stranger });
    const outcome = await xrplAdapter.verify({
      address: mainnet.transactions[0]?.account as string,
      message,
      signature: signed,
    });
    assert.equal(outcome.status, 'unsupported');
    assert.match(outcome.status === 'unsupported' ? outcome.reason : '', /regular key/i);
  });

  test('an empty memo set cannot prove a message', async () => {
    const publicKey = concatBytes(Uint8Array.of(0xed), ed25519.getPublicKey(ED_KEY));
    const address = addressFromPublicKey(publicKey);
    const accountId = addressToAccountId(address) as Uint8Array;
    const unsigned = concatBytes(
      uint16(2, 3),
      uint32(2, 0),
      fixed(6, 8, hexToBytes('4000000000000000') as Uint8Array),
      blob(7, 3, publicKey),
      blob(8, 1, accountId),
    );
    const signature = ed25519.sign(singleSigningData(parseFields(unsigned)), ED_KEY);
    const outcome = await xrplAdapter.verify({
      address,
      message,
      signature: bytesToHex(withSignature(unsigned, signature)),
    });
    assert.equal(outcome.status, 'invalid');
    assert.match(outcome.status === 'invalid' ? outcome.reason : '', /no memo/i);
  });
});

describe('XRPL malformed input', () => {
  const cases: { name: string; address: string; signature: string; field: string }[] = [
    { name: 'empty address', address: '', signature: 'AB', field: 'address' },
    { name: 'not an address', address: 'not-an-address', signature: 'AB', field: 'address' },
    {
      name: 'empty signature',
      address: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
      signature: '',
      field: 'signature',
    },
    {
      name: 'signature is not hex',
      address: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
      signature: 'zzzz',
      field: 'signature',
    },
    {
      name: 'hex that is not a transaction',
      address: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
      signature: 'deadbeef',
      field: 'signature',
    },
  ];

  for (const item of cases) {
    test(item.name, async () => {
      const outcome = await xrplAdapter.verify({
        address: item.address,
        message: 'hello',
        signature: item.signature,
      });
      assert.equal(outcome.status, 'malformed');
      assert.equal(outcome.status === 'malformed' ? outcome.field : null, item.field);
    });
  }
});
