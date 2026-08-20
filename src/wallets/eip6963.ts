/**
 * EIP-6963 multi-injected provider discovery.
 *
 * Reading `window.ethereum` directly breaks as soon as a user has more than one
 * extension installed — whichever one won the race to patch `window` answers
 * for all of them. EIP-6963 instead has each wallet announce itself, so we can
 * show the real list and sign with the provider the user actually picked.
 */

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

export interface Eip6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

export interface Eip6963ProviderDetail {
  info: Eip6963ProviderInfo;
  provider: Eip1193Provider;
}

const detailsByUuid = new Map<string, Eip6963ProviderDetail>();
let listening = false;

function onAnnounce(event: Event): void {
  const detail = (event as CustomEvent<Eip6963ProviderDetail>).detail;
  if (!detail?.info?.uuid || !detail.provider) return;
  detailsByUuid.set(detail.info.uuid, detail);
}

function startListening(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('eip6963:announceProvider', onAnnounce);
}

/**
 * Asks every injected wallet to re-announce and waits a beat for replies.
 * Wallets answer synchronously, but extensions injected late (or after a page
 * restore) can lag by a frame or two.
 */
export async function discoverInjectedProviders(
  waitMs = 120,
): Promise<Eip6963ProviderDetail[]> {
  if (typeof window === 'undefined') return [];
  startListening();
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  await new Promise((resolve) => setTimeout(resolve, waitMs));

  const discovered = [...detailsByUuid.values()];
  if (discovered.length > 0) return discovered;

  // Pre-EIP-6963 fallback. Only trustworthy when a single wallet is installed,
  // which is exactly the case where the standard would not have mattered.
  const legacy = (window as { ethereum?: Eip1193Provider & Record<string, unknown> })
    .ethereum;
  if (!legacy) return [];

  const fallback: Eip6963ProviderDetail = {
    info: {
      uuid: 'legacy-window-ethereum',
      name: legacy['isMetaMask'] === true ? 'MetaMask' : 'Browser wallet',
      icon: '',
      rdns: 'legacy.window.ethereum',
    },
    provider: legacy,
  };
  detailsByUuid.set(fallback.info.uuid, fallback);
  return [fallback];
}

export function getProviderByUuid(uuid: string): Eip6963ProviderDetail | undefined {
  return detailsByUuid.get(uuid);
}
