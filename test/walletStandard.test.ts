import assert from 'node:assert/strict';
import test, { describe, before } from 'node:test';

/**
 * The Wallet Standard registry is shared by every chain, so its behaviour with
 * multi-chain wallets is worth pinning: Phantom announces a Solana wallet and a
 * Bitcoin wallet under the same name, and an earlier version of this registry
 * keyed by name and silently kept only the last one to register.
 */

// The module reads `window` lazily, so a minimal EventTarget stands in for it.
before(() => {
  (globalThis as { window?: unknown }).window = new EventTarget();
});

type AnyWallet = Record<string, unknown>;

function fakeWallet(name: string, feature: string, chains: string[]): AnyWallet {
  return {
    version: '1.0.0',
    name,
    icon: '',
    chains,
    accounts: [{ address: `${name}-${feature}`, publicKey: new Uint8Array(), chains, features: [] }],
    features: {
      'standard:connect': { connect: async () => ({ accounts: [] }) },
      [feature]: { signMessage: async () => ({ signature: new Uint8Array() }) },
    },
  };
}

/**
 * MetaMask's Bitcoin wallet, as observed in the wild: it implements the
 * Bitcoin namespace only and has no `standard:connect` whatsoever.
 */
function metaMaskShapedWallet(): AnyWallet {
  return {
    version: '1.0.0',
    name: 'MetaMask',
    icon: '',
    chains: ['bitcoin:mainnet', 'bitcoin:testnet', 'bitcoin:regtest'],
    accounts: [],
    features: {
      'bitcoin:connect': { connect: async () => ({ accounts: [] }) },
      'bitcoin:disconnect': { disconnect: async () => {} },
      'bitcoin:events': { on: () => () => {} },
      'bitcoin:signAndSendTransaction': {},
      'bitcoin:signMessage': { signMessage: async () => ({ signature: new Uint8Array() }) },
      'bitcoin:signTransaction': {},
      'sats-connect:': {},
    },
  };
}

function announce(...wallets: AnyWallet[]): void {
  const detail = (api: { register(...w: AnyWallet[]): () => void }) => api.register(...wallets);
  (globalThis as { window: EventTarget }).window.dispatchEvent(
    new CustomEvent('wallet-standard:register-wallet', { detail }),
  );
}

describe('Wallet Standard registry', () => {
  let discoverSolanaWallets: (ms?: number) => Promise<{ name: string }[]>;
  let discoverBitcoinWallets: (ms?: number) => Promise<{ name: string }[]>;
  let getStandardWalletByName: (name: string, feature: string) => unknown;

  before(async () => {
    const mod = await import('../src/wallets/walletStandard.ts');
    discoverSolanaWallets = mod.discoverSolanaWallets as typeof discoverSolanaWallets;
    discoverBitcoinWallets = mod.discoverBitcoinWallets as typeof discoverBitcoinWallets;
    getStandardWalletByName = mod.getStandardWalletByName as typeof getStandardWalletByName;

    // The first call attaches the listener that wallets announce themselves to.
    await discoverBitcoinWallets(0);
    announce(
      fakeWallet('Phantom', 'solana:signMessage', ['solana:mainnet']),
      fakeWallet('Phantom', 'bitcoin:signMessage', ['bitcoin:mainnet']),
      // A second Bitcoin wallet using the CAIP-2 chain identifier instead.
      fakeWallet('Leather', 'bitcoin:signMessage', [
        'bip122:000000000019d6689c085ae165831e93',
      ]),
      metaMaskShapedWallet(),
    );
  });

  test('a multi-chain wallet is not overwritten by its own other chain', async () => {
    const bitcoin = await discoverBitcoinWallets(0);
    assert.ok(
      bitcoin.some((wallet) => wallet.name === 'Phantom'),
      'Phantom registered a Bitcoin wallet and should be discoverable',
    );

    const solana = await discoverSolanaWallets(0);
    assert.ok(
      solana.some((wallet) => wallet.name === 'Phantom'),
      'the Solana registration must survive too',
    );
  });

  test('Bitcoin wallets are matched on feature, not chain identifier', async () => {
    const bitcoin = await discoverBitcoinWallets(0);
    // Leather advertises bip122:… rather than bitcoin:…, and must still appear.
    assert.ok(bitcoin.some((wallet) => wallet.name === 'Leather'));
  });

  test('a Solana-only lookup never returns the Bitcoin registration', () => {
    const asBitcoin = getStandardWalletByName('Phantom', 'bitcoin:signMessage') as {
      features: Record<string, unknown>;
    };
    const asSolana = getStandardWalletByName('Phantom', 'solana:signMessage') as {
      features: Record<string, unknown>;
    };

    assert.ok(asBitcoin && asSolana);
    assert.notEqual(asBitcoin, asSolana);
    assert.ok('bitcoin:signMessage' in asBitcoin.features);
    assert.ok('solana:signMessage' in asSolana.features);
  });

  test('a wallet with bitcoin:connect but no standard:connect is discoverable', async () => {
    const bitcoin = await discoverBitcoinWallets(0);
    assert.ok(
      bitcoin.some((wallet) => wallet.name === 'MetaMask'),
      'MetaMask implements only the Bitcoin namespace and must still be offered',
    );
  });

  test('each name is listed once even with several registrations', async () => {
    const bitcoin = await discoverBitcoinWallets(0);
    const names = bitcoin.map((wallet) => wallet.name);
    assert.equal(new Set(names).size, names.length);
  });
});
