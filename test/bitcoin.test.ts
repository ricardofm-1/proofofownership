import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { describe } from 'node:test';

import { bitcoinAdapter } from '../src/chains/bitcoin/index.ts';
import { parseAddress } from '../src/chains/bitcoin/address.ts';
import { bip137MessageHash } from '../src/chains/bitcoin/bip137.ts';
import { bip322MessageHash } from '../src/chains/bitcoin/bip322.ts';
import { bytesToHex } from '../src/lib/bytes.ts';

/**
 * Bitcoin verification is checked against vectors published by the BIP-322
 * authors and by bitcoinjs-message, not against our own signing path. See
 * `test/vectors/README.md` for provenance.
 */

interface Bip322Vectors {
  tx_hashes: { message: string; address: string; message_hash: string }[];
  simple: {
    message: string;
    address: string;
    type: string;
    bip322_signatures: string[];
  }[];
  error: { description: string; message: string; address: string; signature: string }[];
}

interface Bip137Vectors {
  valid: {
    magicHash: { network?: string; message: string; magicHash: string }[];
    verify: {
      network: string;
      message: string;
      address: string;
      signature: string;
      compressed?: { address: string; signature: string };
      segwit?: Record<string, { address: string; signature: string }>;
    }[];
  };
}

const readVectors = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./vectors/${name}`, import.meta.url), 'utf8')) as T;

const bip322 = readVectors<Bip322Vectors>('bip322-basic.json');
const bip137 = readVectors<Bip137Vectors>('bip137-bitcoinjs.json');

describe('Bitcoin message hashing', () => {
  for (const vector of bip137.valid.magicHash.filter((v) => v.network === 'bitcoin')) {
    test(`BIP-137 magic hash of ${JSON.stringify(vector.message)}`, () => {
      assert.equal(bytesToHex(bip137MessageHash(vector.message)), vector.magicHash);
    });
  }

  for (const vector of bip322.tx_hashes) {
    test(`BIP-322 tagged hash of ${JSON.stringify(vector.message)}`, () => {
      assert.equal(bytesToHex(bip322MessageHash(vector.message)), vector.message_hash);
    });
  }
});

describe('BIP-137 verification', () => {
  const mainnet = bip137.valid.verify.filter((v) => v.network === 'bitcoin');

  for (const vector of mainnet) {
    const cases: { label: string; address: string; signature: string }[] = [
      { label: 'P2PKH uncompressed', address: vector.address, signature: vector.signature },
    ];
    if (vector.compressed) cases.push({ label: 'P2PKH compressed', ...vector.compressed });
    for (const [kind, entry] of Object.entries(vector.segwit ?? {})) {
      cases.push({ label: kind, ...entry });
    }

    for (const item of cases) {
      test(`accepts a ${item.label} signature`, async () => {
        const result = await bitcoinAdapter.verify({
          address: item.address,
          message: vector.message,
          signature: item.signature,
        });
        assert.equal(result.status, 'valid');
      });

      test(`rejects a ${item.label} signature over a different message`, async () => {
        const result = await bitcoinAdapter.verify({
          address: item.address,
          message: `${vector.message} `,
          signature: item.signature,
        });
        assert.equal(result.status, 'invalid');
      });
    }
  }

  test('reports the address the key actually controls', async () => {
    const vector = mainnet[0];
    assert.ok(vector?.compressed);
    const result = await bitcoinAdapter.verify({
      address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', // a real address, wrong signer
      message: vector.message,
      signature: vector.compressed.signature,
    });
    assert.equal(result.status, 'invalid');
    assert.equal(
      result.status === 'invalid' ? result.recoveredAddress : undefined,
      vector.compressed.address,
    );
  });
});

describe('BIP-322 simple verification', () => {
  for (const vector of bip322.simple) {
    const scripted = vector.type.startsWith('p2wsh');

    vector.bip322_signatures.forEach((signature, index) => {
      const label = `${vector.type} over ${JSON.stringify(vector.message)} (#${index + 1})`;

      test(scripted ? `declines ${label}` : `accepts ${label}`, async () => {
        const result = await bitcoinAdapter.verify({
          address: vector.address,
          message: vector.message,
          signature,
        });
        // Scripted addresses need a full interpreter; saying so beats guessing.
        assert.equal(result.status, scripted ? 'unsupported' : 'valid');
      });

      if (!scripted) {
        test(`rejects ${label} over a different message`, async () => {
          const result = await bitcoinAdapter.verify({
            address: vector.address,
            message: `${vector.message}!`,
            signature,
          });
          assert.equal(result.status, 'invalid');
        });
      }
    });
  }

  test('accepts a taproot signature with no variant prefix', async () => {
    const vector = bip322.simple.find((v) => v.type === 'p2tr');
    assert.ok(vector);
    assert.ok(!vector.bip322_signatures[0]?.startsWith('smp'));
    const result = await bitcoinAdapter.verify({
      address: vector.address,
      message: vector.message,
      signature: vector.bip322_signatures[0] as string,
    });
    assert.equal(result.status, 'valid');
  });
});

describe('BIP-322 rejection cases from the specification', () => {
  for (const vector of bip322.error) {
    test(`never reports valid: ${vector.description}`, async () => {
      const result = await bitcoinAdapter.verify({
        address: vector.address,
        message: vector.message,
        signature: vector.signature,
      });
      assert.notEqual(result.status, 'valid');
    });
  }

  test('a "ful" prefix is not silently downgraded to simple', async () => {
    const simple = bip322.simple.find((v) => v.type === 'p2wpkh');
    assert.ok(simple);
    const valid = simple.bip322_signatures[0] as string;
    assert.ok(valid.startsWith('smp'));

    const relabelled = `ful${valid.slice(3)}`;
    const result = await bitcoinAdapter.verify({
      address: simple.address,
      message: simple.message,
      signature: relabelled,
    });
    // The payload verifies as simple, so accepting it would mean honouring a
    // signature under rules it did not commit to.
    assert.equal(result.status, 'unsupported');
  });
});

describe('Bitcoin address parsing', () => {
  const cases: [string, string][] = [
    ['1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 'p2pkh'],
    ['3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'p2sh'],
    ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'p2wpkh'],
    ['bc1pss0zhytly75awhm6x2hhvd5lnzv3vssgrf9axfheq8ldyzn88ges79fler', 'p2tr'],
    ['tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'p2wpkh'],
  ];

  for (const [address, kind] of cases) {
    test(`parses ${address.slice(0, 16)}… as ${kind}`, () => {
      assert.equal(parseAddress(address)?.kind, kind);
    });
  }

  test('rejects a taproot address carrying a bech32 checksum', () => {
    // v1 outputs must use bech32m; this is the bech32-checksummed variant.
    assert.equal(parseAddress('bc1pss0zhytly75awhm6x2hhvd5lnzv3vssgrf9axfheq8ldyzn88gesyga46z'), null);
  });

  test('rejects an address with a corrupted checksum', () => {
    assert.equal(parseAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5'), null);
  });

  test('flags a malformed address rather than calling it invalid', async () => {
    const result = await bitcoinAdapter.verify({
      address: 'not-an-address',
      message: 'hello',
      signature: 'AA==',
    });
    assert.equal(result.status, 'malformed');
    assert.equal(result.status === 'malformed' ? result.field : undefined, 'address');
  });
});
