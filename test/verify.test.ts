import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { ethereumAdapter } from '../src/chains/ethereum.ts';
import { solanaAdapter } from '../src/chains/solana.ts';
import { buildProofJson, parseHash } from '../src/lib/share.ts';

/**
 * Verification is the half of this tool that has to be right without anyone
 * watching, so it is pinned to fixed vectors rather than to a round trip
 * against our own signing code.
 *
 * Ethereum vectors come from private key
 * 0x59c6…690d (Hardhat account #1) signing via EIP-191.
 * Solana vectors come from an ed25519 keypair seeded with 32 bytes of 0x07.
 */

const ETH = {
  address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  message: 'hello',
  signature:
    '0x76930d64d2e5eb4b3f4572ce806eda50e1e2329d51d9ca5a713a9befcb9d20883e3d4885c3c5eaf775fc8c9fcf4882a28b582b427bc0270565f3294d935549221b',
};

const ETH_MULTILINE = {
  address: ETH.address,
  message: 'line one\nline two  ',
  signature:
    '0xafa95d97b0497a3e000d8c5007303caa868c4e99b37c0e2f6a2053c37099bce755a9342ddc5383713bb2dd9253446ff8361a0908d0cd9446d64bef0b0a9a76291b',
};

const SOL = {
  address: 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB',
  message: 'hello',
  signature:
    '25A91ktCS5LQuXkFgvEi64er51rHjSdRRunE6mZcGaWuH4AzgFhKRHHKuVbEJgKHXdFgrGaYFWq4qMuFQC1rr15m',
};

describe('Ethereum verification', () => {
  test('accepts a known-good signature', async () => {
    const result = await ethereumAdapter.verify(ETH);
    assert.equal(result.status, 'valid');
  });

  test('preserves whitespace and line breaks', async () => {
    assert.equal((await ethereumAdapter.verify(ETH_MULTILINE)).status, 'valid');
    // Trimming the trailing spaces must break it — that is the whole promise.
    const trimmed = await ethereumAdapter.verify({
      ...ETH_MULTILINE,
      message: ETH_MULTILINE.message.trim(),
    });
    assert.equal(trimmed.status, 'invalid');
  });

  test('tolerates a missing 0x prefix and any address casing', async () => {
    const result = await ethereumAdapter.verify({
      ...ETH,
      address: ETH.address.toLowerCase(),
      signature: ETH.signature.slice(2).toUpperCase(),
    });
    assert.equal(result.status, 'valid');
  });

  test('accepts the EIP-2098 compact form', async () => {
    const body = ETH.signature.slice(2);
    const r = body.slice(0, 64);
    const s = body.slice(64, 128);
    const v = Number.parseInt(body.slice(128), 16);
    const yParity = v - 27;
    const head = (Number.parseInt(s.slice(0, 2), 16) | (yParity << 7))
      .toString(16)
      .padStart(2, '0');
    const compact = `0x${r}${head}${s.slice(2)}`;

    assert.equal((await ethereumAdapter.verify({ ...ETH, signature: compact })).status, 'valid');
  });

  test('reports the real signer when the address does not match', async () => {
    const result = await ethereumAdapter.verify({
      ...ETH,
      address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    });
    assert.equal(result.status, 'invalid');
    assert.equal(
      result.status === 'invalid' ? result.recoveredAddress : undefined,
      ETH.address,
    );
    // The EIP-1271 caveat must be present rather than a silent "invalid".
    assert.match(result.status === 'invalid' ? (result.hint ?? '') : '', /EIP-1271/);
  });

  test('flips to invalid when one character of the message changes', async () => {
    assert.equal((await ethereumAdapter.verify({ ...ETH, message: 'hellp' })).status, 'invalid');
  });

  test('flips to invalid when one character of the signature changes', async () => {
    const flipped = `${ETH.signature.slice(0, -3)}${ETH.signature.at(-3) === 'a' ? 'b' : 'a'}${ETH.signature.slice(-2)}`;
    assert.equal((await ethereumAdapter.verify({ ...ETH, signature: flipped })).status, 'invalid');
  });

  test('names the specific formatting problem', async () => {
    const shortSig = await ethereumAdapter.verify({ ...ETH, signature: '0xdeadbeef' });
    assert.equal(shortSig.status, 'malformed');
    assert.equal(shortSig.status === 'malformed' ? shortSig.field : '', 'signature');

    const badAddress = await ethereumAdapter.verify({ ...ETH, address: 'not-an-address' });
    assert.equal(badAddress.status, 'malformed');
    assert.equal(badAddress.status === 'malformed' ? badAddress.field : '', 'address');

    const badHex = await ethereumAdapter.verify({ ...ETH, signature: `0x${'z'.repeat(130)}` });
    assert.equal(badHex.status, 'malformed');
  });
});

describe('Solana verification', () => {
  test('accepts a known-good signature', async () => {
    assert.equal((await solanaAdapter.verify(SOL)).status, 'valid');
  });

  test('accepts a hex-encoded signature', async () => {
    const bs58 = (await import('bs58')).default;
    const hex = `0x${Buffer.from(bs58.decode(SOL.signature)).toString('hex')}`;
    assert.equal((await solanaAdapter.verify({ ...SOL, signature: hex })).status, 'valid');
  });

  test('flips to invalid when one character of the message changes', async () => {
    assert.equal((await solanaAdapter.verify({ ...SOL, message: 'hellp' })).status, 'invalid');
  });

  test('rejects a wrong-length public key before verifying', async () => {
    const result = await solanaAdapter.verify({ ...SOL, address: '11111111' });
    assert.equal(result.status, 'malformed');
    assert.equal(result.status === 'malformed' ? result.field : '', 'address');
  });

  test('rejects non-base58 input with a readable reason', async () => {
    const result = await solanaAdapter.verify({ ...SOL, address: '0OIl0OIl0OIl' });
    assert.equal(result.status, 'malformed');
    assert.match(result.status === 'malformed' ? result.reason : '', /base58/);
  });
});

describe('shareable links', () => {
  test('round-trips a message containing newlines and unicode', () => {
    const message = 'first line\n\tsecond\tline  \n🔐 é';
    const encoded = new URLSearchParams({
      chain: 'solana',
      address: SOL.address,
      message: Buffer.from(message, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, ''),
      enc: 'b64',
      sig: SOL.signature,
    });

    const { tab, proof } = parseHash(`#/verify?${encoded.toString()}`);
    assert.equal(tab, 'verify');
    assert.equal(proof.chain, 'solana');
    assert.equal(proof.message, message);
    assert.equal(proof.signature, SOL.signature);
  });

  test('treats an unmarked message as plain text', () => {
    const { proof } = parseHash('#/verify?chain=ethereum&message=hello%20there&sig=0x00');
    assert.equal(proof.message, 'hello there');
  });

  test('ignores an unknown chain rather than trusting it', () => {
    const { proof } = parseHash('#/verify?chain=dogecoin');
    assert.equal(proof.chain, undefined);
  });

  test('emits the documented JSON shape', () => {
    const json: unknown = JSON.parse(buildProofJson({ chain: 'ethereum', ...ETH }));
    assert.deepEqual(json, {
      chain: 'ethereum',
      address: ETH.address,
      message: ETH.message,
      signature: ETH.signature,
    });
  });
});
