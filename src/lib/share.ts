import { isChainId, type ChainId } from '../chains/index.ts';

/**
 * Shareable links replace the "publish" step of hosted signature tools: the
 * proof travels inside the URL fragment, which browsers never send to a server.
 * Nothing is stored anywhere, and the link is self-verifying.
 */

export interface Proof {
  chain: ChainId;
  address: string;
  message: string;
  signature: string;
}

export type Tab = 'sign' | 'verify';

export interface ParsedHash {
  tab: Tab | null;
  proof: Partial<Proof>;
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string | null {
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    // `fatal` matters: it turns "this was never base64" into a clean null
    // instead of a string full of replacement characters.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Builds the absolute URL that pre-fills and auto-runs the Verify tab. */
export function buildShareUrl(proof: Proof): string {
  const params = new URLSearchParams({
    chain: proof.chain,
    address: proof.address,
    // Encoded because messages legitimately contain newlines, emoji and
    // anything else that would otherwise be mangled on the way through a URL.
    message: toBase64Url(proof.message),
    enc: 'b64',
    sig: proof.signature,
  });
  const { origin, pathname, search } = window.location;
  return `${origin}${pathname}${search}#/verify?${params.toString()}`;
}

export function buildProofJson(proof: Proof): string {
  return JSON.stringify(
    {
      chain: proof.chain,
      address: proof.address,
      message: proof.message,
      signature: proof.signature,
    },
    null,
    2,
  );
}

/**
 * Reads a location hash of the form `#/verify?chain=…&address=…&message=…&sig=…`.
 * Hand-written links are tolerated: `enc=b64` marks the message as encoded, and
 * without it the message is taken as plain (percent-decoded) text.
 */
export function parseHash(hash: string): ParsedHash {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return { tab: null, proof: {} };

  const queryStart = raw.indexOf('?');
  const path = (queryStart === -1 ? raw : raw.slice(0, queryStart)).replace(/^\//, '');
  const params = new URLSearchParams(queryStart === -1 ? '' : raw.slice(queryStart + 1));

  const tab: Tab | null = path === 'verify' ? 'verify' : path === 'sign' ? 'sign' : null;

  const proof: Partial<Proof> = {};
  const chain = params.get('chain');
  if (chain && isChainId(chain)) proof.chain = chain;

  const address = params.get('address');
  if (address) proof.address = address;

  const signature = params.get('sig') ?? params.get('signature');
  if (signature) proof.signature = signature;

  const message = params.get('message') ?? params.get('msg');
  if (message !== null) {
    const decoded = params.get('enc') === 'b64' ? fromBase64Url(message) : message;
    if (decoded !== null) proof.message = decoded;
  }

  return { tab, proof };
}

export function isCompleteProof(proof: Partial<Proof>): proof is Proof {
  return (
    typeof proof.chain === 'string' &&
    typeof proof.address === 'string' &&
    proof.address.length > 0 &&
    typeof proof.message === 'string' &&
    typeof proof.signature === 'string' &&
    proof.signature.length > 0
  );
}
