import assert from 'node:assert/strict';
import test from 'node:test';

import { pickSessionAccounts } from '../src/chains/ethereum.ts';

test('pickSessionAccounts uses the chain of the first granted account', () => {
  const picked = pickSessionAccounts([
    'eip155:137:0xabc0000000000000000000000000000000000001',
    'eip155:1:0xabc0000000000000000000000000000000000001',
  ]);
  assert.deepEqual(picked, {
    chainId: 137,
    addresses: ['0xabc0000000000000000000000000000000000001'],
  });
});

test('pickSessionAccounts keeps every address on that chain', () => {
  const picked = pickSessionAccounts([
    'eip155:1:0xabc0000000000000000000000000000000000001',
    'eip155:1:0xdef0000000000000000000000000000000000002',
    'eip155:10:0xabc0000000000000000000000000000000000001',
  ]);
  assert.equal(picked?.chainId, 1);
  assert.deepEqual(picked?.addresses, [
    '0xabc0000000000000000000000000000000000001',
    '0xdef0000000000000000000000000000000000002',
  ]);
});

test('pickSessionAccounts rejects empty or malformed CAIP ids', () => {
  assert.equal(pickSessionAccounts([]), null);
  assert.equal(pickSessionAccounts(['eip155']), null);
  assert.equal(pickSessionAccounts(['eip155:notanumber:0xabc']), null);
});
