/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Optional Reown (WalletConnect) Cloud project ID. When absent, the
   * WalletConnect option is disabled but every other feature still works.
   */
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
