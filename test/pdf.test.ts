import assert from 'node:assert/strict';
import test from 'node:test';

import { PDFDocument } from 'pdf-lib';

import {
  certificateFilename,
  isWinAnsiCodePoint,
  toWinAnsi,
  wrapLines,
} from '../src/lib/certificate.ts';
import { buildProofPdf } from '../src/lib/pdf.ts';
import type { ProofCertificate } from '../src/lib/certificate.ts';

test('wrapLines keeps explicit newlines and breaks a long token', () => {
  const lines = wrapLines('hello\nworld', 100, (line) => line.length);
  assert.deepEqual(lines, ['hello', 'world']);

  const wrapped = wrapLines('abcdefghij', 4, (line) => line.length);
  assert.deepEqual(wrapped, ['abcd', 'efgh', 'ij']);
});

test('wrapLines prefers a space over a mid-word cut', () => {
  const lines = wrapLines('one two three', 7, (line) => line.length);
  assert.deepEqual(lines, ['one two', 'three']);
});

test('toWinAnsi passes Latin-1 and flags characters the PDF font cannot draw', () => {
  assert.equal(toWinAnsi('café — €100').substituted, false);
  assert.equal(toWinAnsi('café — €100').text, 'café — €100');

  const emoji = toWinAnsi('hello 👋');
  assert.equal(emoji.substituted, true);
  assert.equal(emoji.text, 'hello ?');
});

test('ASCII, Latin-1 and the Windows-1252 extras are treated as drawable', () => {
  assert.equal(isWinAnsiCodePoint('A'.codePointAt(0)!), true);
  assert.equal(isWinAnsiCodePoint('ã'.codePointAt(0)!), true);
  assert.equal(isWinAnsiCodePoint('€'.codePointAt(0)!), true);
  assert.equal(isWinAnsiCodePoint(0x1f44b), false);
});

test('certificateFilename names the chain and the kind', () => {
  assert.equal(
    certificateFilename({ chainId: 'bitcoin', kind: 'signed' }),
    'proof-of-ownership-bitcoin-signed.pdf',
  );
  assert.equal(
    certificateFilename({ chainId: 'ethereum', kind: 'verified' }),
    'proof-of-ownership-ethereum-verified.pdf',
  );
});

function sample(overrides: Partial<ProofCertificate> = {}): ProofCertificate {
  return {
    kind: 'verified',
    chainId: 'bitcoin',
    chainName: 'Bitcoin',
    signingStandard: 'BIP-137 and BIP-322',
    address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    message: 'I own this address.',
    signature: 'A'.repeat(88),
    generatedAt: new Date('2026-08-21T12:00:00Z'),
    ...overrides,
  };
}

test('buildProofPdf writes a one-page PDF whose title names the chain', async () => {
  const bytes = await buildProofPdf(sample());
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), '%PDF-');

  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 1);
  assert.match(pdf.getTitle() ?? '', /Bitcoin/);
  assert.match(pdf.getTitle() ?? '', /valid/i);
});

test('a long signature spills onto a second page rather than overflowing', async () => {
  const bytes = await buildProofPdf(
    sample({
      signature: 'ab'.repeat(4000),
    }),
  );
  const pdf = await PDFDocument.load(bytes);
  assert.ok(pdf.getPageCount() >= 2);
});

test('a signed certificate is titled as signed, not as verified', async () => {
  const bytes = await buildProofPdf(sample({ kind: 'signed' }));
  const pdf = await PDFDocument.load(bytes);
  assert.match(pdf.getTitle() ?? '', /signed/i);
});
