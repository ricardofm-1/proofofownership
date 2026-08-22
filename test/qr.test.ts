import assert from 'node:assert/strict';
import test from 'node:test';

import { qrSvgForText } from '../src/lib/qr.ts';

test('qrSvgForText returns a square SVG for a bech32 address', async () => {
  const svg = await qrSvgForText('bc1qeywc96rfefjr4220zewj9zxmds4yz0ctl0h63z');
  assert.match(svg, /^<svg\b/);
  assert.match(svg, /viewBox="/);
  assert.equal(svg, await qrSvgForText('bc1qeywc96rfefjr4220zewj9zxmds4yz0ctl0h63z'));
});

test('a longer Cardano address still encodes to SVG', async () => {
  const svg = await qrSvgForText(
    'addr1q8qwc455erdfevgj8xv78r262fs8eu6xln9u3s7lps8vvygckhpjgqxgmkcxvr2zhjjrdd9ty9ggev4yahznlzymg8cs5n6pt6',
  );
  assert.match(svg, /^<svg\b/);
  assert.ok(svg.length > 200);
});
