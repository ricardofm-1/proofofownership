/**
 * The seam that keeps the UI chain-agnostic.
 *
 * Adding a chain (Bitcoin BIP-322, XRPL, Cardano CIP-8, …) should mean writing
 * one more module that satisfies `ChainAdapter` and registering it — no UI
 * changes. Everything the interface exposes is either pure local cryptography
 * (`verify`) or an explicit user-initiated wallet interaction (`connect`,
 * `signMessage`).
 */

export type ChainId = 'ethereum' | 'solana' | 'bitcoin';

/** A wallet the user could pick for the currently selected chain. */
export interface WalletOption {
  /** Stable within a chain; passed back to `connect`. */
  id: string;
  name: string;
  /** Data URI supplied by the wallet itself (EIP-6963 / Wallet Standard). */
  icon?: string | undefined;
  /** False when the wallet is not installed or is missing a required config. */
  available: boolean;
  /** Shown in place of the wallet when `available` is false. */
  unavailableReason?: string | undefined;
  /** Where to get the wallet, when it is not installed. */
  installUrl?: string | undefined;
}

/** A live wallet session. Only ever created by an explicit user action. */
export interface Connection {
  walletId: string;
  walletName: string;
  /** Chain-native address encoding: EIP-55 hex for EVM, base58 for Solana. */
  address: string;
  /**
   * Signs the message exactly as given — no trimming, no normalisation.
   * Returns the canonical signature encoding for the chain.
   */
  signMessage(message: string): Promise<string>;
  disconnect(): Promise<void>;
}

export type VerifyOutcome =
  | { status: 'valid'; address: string }
  | {
      status: 'invalid';
      reason: string;
      /** Present when the signature was well-formed but belongs elsewhere. */
      recoveredAddress?: string | undefined;
      /** Extra context, e.g. the smart-contract-wallet caveat. */
      hint?: string | undefined;
    }
  | {
      status: 'malformed';
      reason: string;
      field: 'address' | 'signature' | 'message';
    }
  /**
   * The input is well-formed but this tool cannot decide it — for example a
   * BIP-322 signature over a multisig script, which needs a full Bitcoin
   * script interpreter. Saying so is the honest answer; calling it invalid
   * would be a false negative on a possibly genuine proof.
   */
  | {
      status: 'unsupported';
      reason: string;
      hint?: string | undefined;
    };

export interface VerifyInput {
  address: string;
  message: string;
  signature: string;
}

export interface ChainAdapter {
  readonly id: ChainId;
  readonly name: string;
  /** Placeholder text describing the address format, shown in the Verify tab. */
  readonly addressPlaceholder: string;
  readonly signaturePlaceholder: string;
  /** Human description of the signature encoding, e.g. "hex (0x…)". */
  readonly signatureEncoding: string;
  /** Which signing standard this adapter implements, shown in the UI. */
  readonly signingStandard: string;
  /** Notes on which input formats the Verify tab will accept. */
  readonly verifyHint: string;

  /** Discovers wallets. Must not trigger connection prompts. */
  listWallets(): Promise<WalletOption[]>;
  connect(walletId: string): Promise<Connection>;

  /**
   * Verifies fully offline. Implementations must never touch the network,
   * an RPC endpoint, or a wallet.
   */
  verify(input: VerifyInput): Promise<VerifyOutcome>;
}

/** Thrown when the user dismisses a wallet prompt; the UI stays quiet for these. */
export class UserRejectedError extends Error {
  constructor(message = 'Request rejected in the wallet.') {
    super(message);
    this.name = 'UserRejectedError';
  }
}

/** Thrown for problems we can explain in plain language. */
export class WalletError extends Error {
  readonly actionUrl?: string | undefined;
  readonly actionLabel?: string | undefined;

  constructor(
    message: string,
    options: { actionUrl?: string; actionLabel?: string } = {},
  ) {
    super(message);
    this.name = 'WalletError';
    this.actionUrl = options.actionUrl;
    this.actionLabel = options.actionLabel;
  }
}
