import { bitcoinAdapter } from './bitcoin/index.ts';
import { ethereumAdapter } from './ethereum.ts';
import { solanaAdapter } from './solana.ts';
import type { ChainAdapter, ChainId } from './types.ts';

/**
 * The adapter registry. Adding XRPL or Cardano means appending one entry here
 * and widening `ChainId`; the UI reads everything else off the adapter itself.
 */
export const adapters: readonly ChainAdapter[] = [
  ethereumAdapter,
  solanaAdapter,
  bitcoinAdapter,
];

export const defaultChainId: ChainId = 'ethereum';

export function getAdapter(id: ChainId): ChainAdapter {
  const adapter = adapters.find((candidate) => candidate.id === id);
  if (!adapter) throw new Error(`No adapter registered for chain "${id}".`);
  return adapter;
}

export function isChainId(value: string): value is ChainId {
  return adapters.some((adapter) => adapter.id === value);
}

export * from './types.ts';
