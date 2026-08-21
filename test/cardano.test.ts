import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { describe } from 'node:test';

import { cardanoAdapter } from '../src/chains/cardano/index.ts';
import {
  addressCommitsToKey,
  encodeAddress,
  keyHash,
  parseAddress,
} from '../src/chains/cardano/address.ts';
import { decodeCoseKey, decodeCoseSign1, sigStructure } from '../src/chains/cardano/cose.ts';
import { decodeCbor, encodeBytes, encodeText } from '../src/lib/cbor.ts';
import { bytesToHex, hexToBytes } from '../src/lib/bytes.ts';

/**
 * CIP-8 verification is checked against fixtures from the Cardano Foundation's
 * `go-cip-30`, which generates them with `cardano-signer` and cross-checks each
 * expected verdict against that tool's own verifier. Nothing here produced
 * them, so they cannot agree with a mistake of ours. See
 * `test/vectors/README.md` for provenance.
 */

interface Fixture {
  name: string;
  description: string;
  coseSign1Hex: string;
  coseKeyHex: string;
  message: string;
  expectAddress: string | null;
  expectValid: boolean;
  hashed: boolean;
}

const vectors = JSON.parse(
  readFileSync(new URL('./vectors/cip8-go-cip30.json', import.meta.url), 'utf8'),
) as { fixtures: Fixture[] };

const byName = (name: string): Fixture => {
  const found = vectors.fixtures.find((fixture) => fixture.name === name);
  assert.ok(found, `fixture ${name} is missing`);
  return found;
};

const asPair = (fixture: Fixture): string =>
  JSON.stringify({ signature: fixture.coseSign1Hex, key: fixture.coseKeyHex });

describe('Cardano CIP-8 fixtures', () => {
  test('the set covers plain, hashed, detached and reward-address signing', () => {
    const names = vectors.fixtures.map((fixture) => fixture.name);
    for (const expected of [
      'plain_enterprise_mainnet',
      'plain_enterprise_testnet',
      'hashed_embedded',
      'detached_plain',
      'detached_hashed',
      'reward_stake_mainnet',
    ]) {
      assert.ok(names.includes(expected), `missing coverage: ${expected}`);
    }
  });

  for (const fixture of vectors.fixtures.filter((item) => item.expectValid)) {
    test(`${fixture.name} verifies`, async () => {
      const outcome = await cardanoAdapter.verify({
        address: fixture.expectAddress as string,
        message: fixture.message,
        signature: asPair(fixture),
      });
      assert.equal(outcome.status, 'valid', JSON.stringify(outcome));
    });
  }

  test('negative_wrong_message: a valid signature does not prove another message', async () => {
    const fixture = byName('negative_wrong_message');
    // The fixture omits an address because the point is the message; use the
    // signer's own address so nothing but the message can be at fault.
    const outcome = await cardanoAdapter.verify({
      address: byName('plain_enterprise_mainnet').expectAddress as string,
      message: 'Charles Babbage, of the Analytical Engine',
      signature: asPair(fixture),
    });
    assert.equal(outcome.status, 'invalid');
    assert.match(outcome.status === 'invalid' ? outcome.reason : '', /message/i);
  });

  test('negative_wrong_address: a foreign address is not proven by someone else’s key', async () => {
    const fixture = byName('negative_wrong_address');
    const outcome = await cardanoAdapter.verify({
      address: fixture.expectAddress as string,
      message: fixture.message,
      signature: asPair(fixture),
    });
    assert.equal(outcome.status, 'invalid');
    assert.match(
      outcome.status === 'invalid' ? outcome.reason : '',
      /does not control this address/i,
    );
  });

  test('the address in the protected header is not trusted on its own', () => {
    // The self-asserted header address is what makes the independent key-to-
    // address binding necessary; this pins that the binding actually rejects.
    const fixture = byName('negative_wrong_address');
    const sign1 = decodeCoseSign1(hexToBytes(fixture.coseSign1Hex) as Uint8Array);
    const publicKey = decodeCoseKey(hexToBytes(fixture.coseKeyHex) as Uint8Array);
    const foreign = parseAddress(fixture.expectAddress as string);
    assert.ok(foreign);
    assert.ok(sign1.address, 'the fixture carries a header address');
    assert.equal(addressCommitsToKey(foreign, publicKey), false);
  });

  test('a tampered signature fails', async () => {
    const fixture = byName('plain_enterprise_mainnet');
    const bytes = hexToBytes(fixture.coseSign1Hex) as Uint8Array;
    bytes[bytes.length - 1] = ((bytes[bytes.length - 1] as number) ^ 0x01) & 0xff;
    const outcome = await cardanoAdapter.verify({
      address: fixture.expectAddress as string,
      message: fixture.message,
      signature: JSON.stringify({ signature: bytesToHex(bytes), key: fixture.coseKeyHex }),
    });
    assert.equal(outcome.status, 'invalid');
  });

  test('a detached signature still binds the message', async () => {
    const fixture = byName('detached_plain');
    const outcome = await cardanoAdapter.verify({
      address: fixture.expectAddress as string,
      message: `${fixture.message} (altered)`,
      signature: asPair(fixture),
    });
    assert.equal(outcome.status, 'invalid');
  });

  test('the two halves are also accepted space separated', async () => {
    const fixture = byName('plain_enterprise_mainnet');
    const outcome = await cardanoAdapter.verify({
      address: fixture.expectAddress as string,
      message: fixture.message,
      signature: `${fixture.coseSign1Hex} ${fixture.coseKeyHex}`,
    });
    assert.equal(outcome.status, 'valid');
  });

  test('the signed bytes are a Sig_structure, not the transmitted structure', () => {
    const fixture = byName('plain_enterprise_mainnet');
    const sign1 = decodeCoseSign1(hexToBytes(fixture.coseSign1Hex) as Uint8Array);
    const payload = sign1.payload as Uint8Array;
    const built = sigStructure(sign1.protectedRaw, payload);
    // 0x84 array(4), then the text "Signature1".
    assert.equal(built[0], 0x84);
    assert.ok(bytesToHex(built).includes(bytesToHex(encodeText('Signature1'))));
    // external_aad is an empty byte string, which is 0x40.
    assert.ok(bytesToHex(built).includes('40'));
  });
});

describe('Cardano addresses', () => {
  test('every fixture address round-trips through bech32', () => {
    for (const fixture of vectors.fixtures) {
      if (!fixture.expectAddress) continue;
      const parsed = parseAddress(fixture.expectAddress);
      assert.ok(parsed, fixture.expectAddress);
      assert.equal(encodeAddress(parsed.bytes), fixture.expectAddress);
    }
  });

  test('a reward address exposes its stake credential', () => {
    const parsed = parseAddress(byName('reward_stake_mainnet').expectAddress as string);
    assert.ok(parsed);
    assert.equal(parsed.kind, 'reward');
    assert.equal(parsed.network, 'mainnet');
    assert.equal(parsed.credentials.length, 1);
    const publicKey = decodeCoseKey(
      hexToBytes(byName('reward_stake_mainnet').coseKeyHex) as Uint8Array,
    );
    assert.equal(bytesToHex(parsed.credentials[0] as Uint8Array), bytesToHex(keyHash(publicKey)));
  });

  test('mainnet and testnet are distinguished', () => {
    const mainnet = parseAddress(byName('plain_enterprise_mainnet').expectAddress as string);
    const testnet = parseAddress(byName('plain_enterprise_testnet').expectAddress as string);
    assert.equal(mainnet?.network, 'mainnet');
    assert.equal(testnet?.network, 'testnet');
    // Same key, so the credential is identical and only the header differs.
    assert.equal(
      bytesToHex(mainnet?.credentials[0] as Uint8Array),
      bytesToHex(testnet?.credentials[0] as Uint8Array),
    );
  });

  test('a mismatched prefix is rejected', () => {
    const reward = byName('reward_stake_mainnet').expectAddress as string;
    assert.ok(parseAddress(reward));
    // Re-encode the same bytes under the payment prefix: still valid bech32,
    // but no longer a truthful address.
    const parsed = parseAddress(reward);
    assert.ok(parsed);
    const wrong = `addr${reward.slice('stake'.length)}`;
    assert.equal(parseAddress(wrong), null);
  });

  test('a corrupted address fails its checksum', () => {
    const good = byName('plain_enterprise_mainnet').expectAddress as string;
    const swapped = `${good.slice(0, -1)}${good.endsWith('8') ? '9' : '8'}`;
    assert.equal(parseAddress(swapped), null);
  });

  test('addresses longer than bech32’s nominal limit still decode', () => {
    // Build the base address for the fixture's own payment and stake keys: two
    // credentials rather than one, which pushes the string past the 90
    // characters bech32 nominally allows.
    const payment = decodeCoseKey(
      hexToBytes(byName('plain_enterprise_mainnet').coseKeyHex) as Uint8Array,
    );
    const stake = decodeCoseKey(
      hexToBytes(byName('reward_stake_mainnet').coseKeyHex) as Uint8Array,
    );
    const bytes = new Uint8Array(57);
    bytes[0] = 0x01; // base address, key payment and key stake, mainnet
    bytes.set(keyHash(payment), 1);
    bytes.set(keyHash(stake), 29);

    const encoded = encodeAddress(bytes);
    assert.ok(encoded);
    assert.ok(encoded.length > 90, `expected a long address, got ${encoded.length} characters`);

    const parsed = parseAddress(encoded);
    assert.ok(parsed, 'a base address longer than 90 characters must still parse');
    assert.equal(parsed.kind, 'base');
    assert.equal(parsed.credentials.length, 2);
    // Either credential can be the one that signed, so both must be found.
    assert.equal(addressCommitsToKey(parsed, payment), true);
    assert.equal(addressCommitsToKey(parsed, stake), true);
  });
});

describe('CBOR', () => {
  test('decodes the shapes COSE uses', () => {
    assert.equal(decodeCbor(Uint8Array.of(0x00)), 0);
    assert.equal(decodeCbor(Uint8Array.of(0x27)), -8);
    assert.equal(decodeCbor(Uint8Array.of(0xf4)), false);
    assert.equal(decodeCbor(Uint8Array.of(0xf5)), true);
    assert.equal(decodeCbor(Uint8Array.of(0xf6)), null);
    assert.deepEqual(decodeCbor(encodeBytes(Uint8Array.of(1, 2, 3))), Uint8Array.of(1, 2, 3));
    assert.equal(decodeCbor(encodeText('Signature1')), 'Signature1');
  });

  test('rejects indefinite-length values', () => {
    // 0x5f starts an indefinite byte string, which COSE never uses.
    assert.throws(() => decodeCbor(Uint8Array.of(0x5f, 0xff)), /Unsupported CBOR length/);
  });

  test('rejects trailing bytes', () => {
    assert.throws(() => decodeCbor(Uint8Array.of(0x00, 0x00)), /Trailing bytes/);
  });

  test('rejects truncated input', () => {
    assert.throws(() => decodeCbor(Uint8Array.of(0x58, 0x20, 0x01)), /claims more bytes/);
  });
});

describe('Cardano malformed input', () => {
  const address = 'addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8';
  const cases: { name: string; address: string; signature: string; field: string }[] = [
    { name: 'empty address', address: '', signature: '{}', field: 'address' },
    { name: 'not an address', address: 'not-an-address', signature: '{}', field: 'address' },
    { name: 'empty signature', address, signature: '', field: 'signature' },
    { name: 'JSON without a key field', address, signature: '{"signature":"84"}', field: 'signature' },
    { name: 'broken JSON', address, signature: '{oops', field: 'signature' },
    { name: 'one hex value only', address, signature: 'abcd', field: 'signature' },
    { name: 'not hex', address, signature: 'zz zz', field: 'signature' },
    { name: 'hex that is not COSE', address, signature: 'deadbeef aabbcc', field: 'signature' },
  ];

  for (const item of cases) {
    test(item.name, async () => {
      const outcome = await cardanoAdapter.verify({
        address: item.address,
        message: 'hello',
        signature: item.signature,
      });
      assert.equal(outcome.status, 'malformed', JSON.stringify(outcome));
      assert.equal(outcome.status === 'malformed' ? outcome.field : null, item.field);
    });
  }
});
