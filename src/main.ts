import './styles.css';

import {
  adapters,
  defaultChainId,
  getAdapter,
  UserRejectedError,
  WalletError,
  type ChainAdapter,
  type ChainId,
  type Connection,
  type VerifyOutcome,
  type WalletOption,
} from './chains/index.ts';
import { copyText, el, elAll, flashButton, truncateAddress } from './lib/dom.ts';
import {
  buildProofJson,
  buildShareUrl,
  isCompleteProof,
  parseHash,
  type Proof,
  type Tab,
} from './lib/share.ts';

// ── Elements ───────────────────────────────────────────────────────────────

const chainSelector = el('#chain-selector');
const tabButtons = elAll<HTMLButtonElement>('[role="tab"]');
const panels: Record<Tab, HTMLElement> = {
  sign: el('#panel-sign'),
  verify: el('#panel-verify'),
};

const signStandard = el('#sign-standard');
const verifyStandard = el('#verify-standard');

const walletDisconnected = el('#wallet-disconnected');
const walletConnected = el('#wallet-connected');
const connectButton = el<HTMLButtonElement>('#connect-button');
const connectedWalletName = el('#connected-wallet-name');
const connectedAddress = el('#connected-address');
const copyAddressButton = el<HTMLButtonElement>('#copy-address-button');
const disconnectButton = el<HTMLButtonElement>('#disconnect-button');

const signMessageInput = el<HTMLTextAreaElement>('#sign-message');
const signButton = el<HTMLButtonElement>('#sign-button');
const signError = el('#sign-error');
const signResult = el('#sign-result');
const resultAddress = el('#result-address');
const resultMessage = el('#result-message');
const resultSignature = el('#result-signature');
const copyJsonButton = el<HTMLButtonElement>('#copy-json-button');
const copyLinkButton = el<HTMLButtonElement>('#copy-link-button');
const openVerifyButton = el<HTMLButtonElement>('#open-verify-button');

const verifyAddressInput = el<HTMLInputElement>('#verify-address');
const verifyMessageInput = el<HTMLTextAreaElement>('#verify-message');
const verifySignatureInput = el<HTMLTextAreaElement>('#verify-signature');
const verifySignatureHint = el('#verify-signature-hint');
const verifyButton = el<HTMLButtonElement>('#verify-button');
const clearVerifyButton = el<HTMLButtonElement>('#clear-verify-button');
const verifyResult = el('#verify-result');

const walletDialog = el<HTMLDialogElement>('#wallet-dialog');
const walletList = el<HTMLUListElement>('#wallet-list');
const walletDialogClose = el<HTMLButtonElement>('#wallet-dialog-close');
const walletDialogError = el('#wallet-dialog-error');

// ── State ──────────────────────────────────────────────────────────────────

interface State {
  chainId: ChainId;
  tab: Tab;
  connection: Connection | null;
  proof: Proof | null;
}

const state: State = {
  chainId: defaultChainId,
  tab: 'sign',
  connection: null,
  proof: null,
};

function adapter(): ChainAdapter {
  return getAdapter(state.chainId);
}

// ── Chain selector ─────────────────────────────────────────────────────────

function buildChainSelector(): void {
  for (const chain of adapters) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'segment';
    button.setAttribute('role', 'radio');
    button.dataset['chain'] = chain.id;
    button.textContent = chain.name;
    chainSelector.append(button);
  }
}

function paintChainSelector(): void {
  for (const button of elAll<HTMLButtonElement>('[data-chain]', chainSelector)) {
    const selected = button.dataset['chain'] === state.chainId;
    button.setAttribute('aria-checked', String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
}

async function setChain(chainId: ChainId): Promise<void> {
  if (chainId === state.chainId) return;
  state.chainId = chainId;
  // The open picker lists the previous chain's wallets.
  walletDialog.close();
  // A connection belongs to one chain's wallet; carrying it across would let
  // the UI show an Ethereum address while the Solana adapter is active.
  await disconnect();
  clearSignResult();
  clearVerifyResult();
  paintChainSelector();
  paintChainCopy();
}

function paintChainCopy(): void {
  const active = adapter();
  signStandard.textContent = active.signingStandard;
  verifyStandard.textContent = `${active.signingStandard} · checked in this browser`;
  verifyAddressInput.placeholder = active.addressPlaceholder;
  verifySignatureInput.placeholder = active.signaturePlaceholder;
  verifySignatureHint.textContent = active.verifyHint;
}

// ── Tabs ───────────────────────────────────────────────────────────────────

function setTab(tab: Tab): void {
  state.tab = tab;
  for (const button of tabButtons) {
    const selected = button.dataset['tab'] === tab;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  panels.sign.hidden = tab !== 'sign';
  panels.verify.hidden = tab !== 'verify';
}

/**
 * Arrow-key navigation for both segmented controls. Native radios and tabs get
 * this for free; hand-rolled ones have to earn it.
 */
function wireRovingFocus(container: Element, selector: string): void {
  container.addEventListener('keydown', (event) => {
    const keyboardEvent = event as KeyboardEvent;
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!keys.includes(keyboardEvent.key)) return;

    const items = elAll<HTMLButtonElement>(selector, container);
    const current = items.findIndex((item) => item === document.activeElement);
    if (current === -1) return;
    keyboardEvent.preventDefault();

    const step =
      keyboardEvent.key === 'ArrowLeft' || keyboardEvent.key === 'ArrowUp' ? -1 : 1;
    const next =
      keyboardEvent.key === 'Home'
        ? 0
        : keyboardEvent.key === 'End'
          ? items.length - 1
          : (current + step + items.length) % items.length;

    items[next]?.focus();
    items[next]?.click();
  });
}

// ── Wallet connection ──────────────────────────────────────────────────────

function paintConnection(): void {
  const connection = state.connection;
  walletDisconnected.hidden = connection !== null;
  walletConnected.hidden = connection === null;
  signButton.disabled = connection === null || signMessageInput.value.length === 0;

  if (!connection) return;
  connectedWalletName.textContent = connection.walletName;
  connectedAddress.textContent = truncateAddress(connection.address, 10, 8);
  connectedAddress.title = connection.address;
}

async function disconnect(): Promise<void> {
  const connection = state.connection;
  state.connection = null;
  paintConnection();
  if (connection) await connection.disconnect();
}

/** Wallet icons are data URIs by spec; anything remote would be a tracking beacon. */
function walletIcon(option: WalletOption): HTMLElement {
  if (option.icon?.startsWith('data:')) {
    const img = document.createElement('img');
    img.src = option.icon;
    img.alt = '';
    return img;
  }
  const glyph = document.createElement('span');
  glyph.className = 'wallet-glyph';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = option.name.slice(0, 1).toUpperCase();
  return glyph;
}

function walletChoiceText(option: WalletOption): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'wallet-choice-text';
  const name = document.createElement('span');
  name.textContent = option.name;
  wrap.append(name);
  if (option.unavailableReason) {
    const note = document.createElement('small');
    note.textContent = option.unavailableReason;
    wrap.append(note);
  }
  return wrap;
}

function renderWalletList(options: WalletOption[]): void {
  walletList.replaceChildren();

  for (const option of options) {
    const item = document.createElement('li');

    if (option.available) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'wallet-choice';
      button.append(walletIcon(option), walletChoiceText(option));
      button.addEventListener('click', () => void chooseWallet(option));
      item.append(button);
    } else if (option.installUrl) {
      const link = document.createElement('a');
      link.className = 'wallet-choice';
      link.href = option.installUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const cta = document.createElement('span');
      cta.className = 'wallet-choice-cta';
      cta.textContent = 'Install ↗';
      link.append(walletIcon(option), walletChoiceText(option), cta);
      item.append(link);
    } else {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'wallet-choice';
      button.disabled = true;
      button.append(walletIcon(option), walletChoiceText(option));
      item.append(button);
    }

    walletList.append(item);
  }
}

async function openWalletDialog(): Promise<void> {
  walletDialogError.hidden = true;
  walletList.replaceChildren();

  const placeholder = document.createElement('li');
  placeholder.className = 'hint';
  placeholder.textContent = 'Looking for wallets…';
  walletList.append(placeholder);
  walletDialog.showModal();

  const options = await adapter().listWallets();
  if (!walletDialog.open) return;
  renderWalletList(options);
}

async function chooseWallet(option: WalletOption): Promise<void> {
  walletDialogError.hidden = true;
  try {
    state.connection = await adapter().connect(option.id);
    walletDialog.close();
    paintConnection();
    signError.hidden = true;
  } catch (error) {
    if (error instanceof UserRejectedError) {
      walletDialog.close();
      return;
    }
    showDialogError(error);
  }
}

function showDialogError(error: unknown): void {
  walletDialogError.replaceChildren(document.createTextNode(describeError(error)));
  if (error instanceof WalletError && error.actionUrl) {
    const link = document.createElement('a');
    link.href = error.actionUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = ` ${error.actionLabel ?? 'Learn more'} ↗`;
    walletDialogError.append(link);
  }
  walletDialogError.hidden = false;
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong. Please try again.';
}

// ── Signing ────────────────────────────────────────────────────────────────

function clearSignResult(): void {
  state.proof = null;
  signResult.hidden = true;
  signError.hidden = true;
}

async function signMessage(): Promise<void> {
  const connection = state.connection;
  if (!connection) return;

  const message = signMessageInput.value;
  signError.hidden = true;
  signButton.disabled = true;
  const originalLabel = signButton.textContent;
  signButton.textContent = 'Check your wallet…';

  try {
    const signature = await connection.signMessage(message);
    state.proof = {
      chain: state.chainId,
      address: connection.address,
      message,
      signature,
    };
    renderProof(state.proof);
  } catch (error) {
    if (!(error instanceof UserRejectedError)) {
      signError.textContent = describeError(error);
      signError.hidden = false;
    }
  } finally {
    signButton.textContent = originalLabel;
    paintConnection();
  }
}

function renderProof(proof: Proof): void {
  resultAddress.textContent = proof.address;
  resultMessage.textContent = proof.message;
  resultSignature.textContent = proof.signature;
  signResult.hidden = false;
  signResult.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Verification ───────────────────────────────────────────────────────────

function clearVerifyResult(): void {
  verifyResult.hidden = true;
  verifyResult.replaceChildren();
  verifyAddressInput.removeAttribute('aria-invalid');
  verifySignatureInput.removeAttribute('aria-invalid');
}

function verdictHeadline(text: string): HTMLElement {
  const headline = document.createElement('p');
  headline.className = 'verdict-headline';
  headline.textContent = text;
  return headline;
}

function verdictParagraph(className: string, text: string): HTMLElement {
  const paragraph = document.createElement('p');
  paragraph.className = className;
  paragraph.textContent = text;
  return paragraph;
}

function certificateStamp(label: string): HTMLElement {
  const stamp = document.createElement('div');
  stamp.className = 'stamp';
  stamp.setAttribute('aria-hidden', 'true');

  const main = document.createElement('span');
  main.className = 'stamp-main';
  main.textContent = 'Verified';

  const sub = document.createElement('span');
  sub.className = 'stamp-sub';
  sub.textContent = label;

  stamp.append(main, sub);
  return stamp;
}

function renderVerdict(outcome: VerifyOutcome, active: ChainAdapter): void {
  verifyResult.replaceChildren();
  verifyResult.hidden = false;
  verifyAddressInput.removeAttribute('aria-invalid');
  verifySignatureInput.removeAttribute('aria-invalid');

  const body = document.createElement('div');
  body.className = 'verdict-body';

  if (outcome.status === 'valid') {
    verifyResult.className = 'verdict is-valid';
    body.append(verdictHeadline('Valid signature'));

    const detail = document.createElement('p');
    detail.className = 'verdict-detail';
    detail.append(document.createTextNode('This message was signed by '));
    const address = document.createElement('code');
    address.className = 'mono';
    address.textContent = outcome.address;
    detail.append(address, document.createTextNode('.'));
    body.append(detail);

    body.append(
      verdictParagraph(
        'verdict-detail',
        `Checked with ${active.signingStandard}, entirely in this browser. No request left your device.`,
      ),
    );
    verifyResult.append(body, certificateStamp(active.name));
    return;
  }

  verifyResult.className = 'verdict is-invalid';

  if (outcome.status === 'malformed') {
    body.append(verdictHeadline('Invalid — the input is malformed'));
    body.append(verdictParagraph('verdict-detail', outcome.reason));
    const field =
      outcome.field === 'address' ? verifyAddressInput : verifySignatureInput;
    if (outcome.field !== 'message') field.setAttribute('aria-invalid', 'true');
    verifyResult.append(body);
    return;
  }

  body.append(verdictHeadline('Invalid signature'));
  body.append(verdictParagraph('verdict-detail', outcome.reason));

  if (outcome.recoveredAddress) {
    const block = document.createElement('div');
    block.className = 'verdict-recovered';
    const label = document.createElement('span');
    label.textContent = 'Actually signed by';
    const value = document.createElement('code');
    value.className = 'mono';
    value.textContent = outcome.recoveredAddress;
    block.append(label, value);
    body.append(block);
  }

  if (outcome.hint) body.append(verdictParagraph('verdict-note', outcome.hint));

  verifyResult.append(body);
}

async function runVerification(): Promise<void> {
  const active = adapter();
  verifyButton.disabled = true;
  try {
    const outcome = await active.verify({
      address: verifyAddressInput.value,
      message: verifyMessageInput.value,
      signature: verifySignatureInput.value,
    });
    renderVerdict(outcome, active);
  } catch (error) {
    renderVerdict(
      { status: 'invalid', reason: describeError(error) },
      active,
    );
  } finally {
    verifyButton.disabled = false;
  }
}

function fillVerifyForm(proof: Proof): void {
  verifyAddressInput.value = proof.address;
  verifyMessageInput.value = proof.message;
  verifySignatureInput.value = proof.signature;
}

// ── Shareable links ────────────────────────────────────────────────────────

async function applyHash(): Promise<void> {
  const { tab, proof } = parseHash(window.location.hash);
  if (proof.chain) await setChain(proof.chain);

  if (proof.address !== undefined) verifyAddressInput.value = proof.address;
  if (proof.message !== undefined) verifyMessageInput.value = proof.message;
  if (proof.signature !== undefined) verifySignatureInput.value = proof.signature;

  if (tab) setTab(tab);

  const candidate = { chain: state.chainId, ...proof };
  if (tab === 'verify' && isCompleteProof(candidate)) await runVerification();
}

// ── Wiring ─────────────────────────────────────────────────────────────────

buildChainSelector();
paintChainSelector();
paintChainCopy();
setTab('sign');
paintConnection();

chainSelector.addEventListener('click', (event) => {
  const button = (event.target as Element).closest<HTMLElement>('[data-chain]');
  const chainId = button?.dataset['chain'];
  if (chainId) void setChain(chainId as ChainId);
});
wireRovingFocus(chainSelector, '[data-chain]');

for (const button of tabButtons) {
  button.addEventListener('click', () => setTab(button.dataset['tab'] as Tab));
}
wireRovingFocus(el('[role="tablist"]'), '[role="tab"]');

connectButton.addEventListener('click', () => void openWalletDialog());
walletDialogClose.addEventListener('click', () => walletDialog.close());

walletDialog.addEventListener('click', (event) => {
  // Clicks land on the <dialog> itself only when they hit the backdrop.
  if (event.target === walletDialog) walletDialog.close();
});
disconnectButton.addEventListener('click', () => void disconnect());

copyAddressButton.addEventListener('click', () => {
  const address = state.connection?.address;
  if (address) void copyAndFlash(copyAddressButton, address);
});

signMessageInput.addEventListener('input', paintConnection);
signButton.addEventListener('click', () => void signMessage());

for (const button of elAll<HTMLButtonElement>('[data-copy]', signResult)) {
  button.addEventListener('click', () => {
    const proof = state.proof;
    if (!proof) return;
    const key = button.dataset['copy'] as keyof Proof;
    void copyAndFlash(button, String(proof[key]));
  });
}

copyJsonButton.addEventListener('click', () => {
  if (state.proof) void copyAndFlash(copyJsonButton, buildProofJson(state.proof));
});

copyLinkButton.addEventListener('click', () => {
  if (state.proof) void copyAndFlash(copyLinkButton, buildShareUrl(state.proof));
});

openVerifyButton.addEventListener('click', () => {
  if (!state.proof) return;
  fillVerifyForm(state.proof);
  setTab('verify');
  void runVerification();
});

verifyButton.addEventListener('click', () => void runVerification());

clearVerifyButton.addEventListener('click', () => {
  verifyAddressInput.value = '';
  verifyMessageInput.value = '';
  verifySignatureInput.value = '';
  clearVerifyResult();
  verifyAddressInput.focus();
});

for (const input of [verifyAddressInput, verifyMessageInput, verifySignatureInput]) {
  // A stale verdict next to edited inputs is worse than no verdict.
  input.addEventListener('input', clearVerifyResult);
}

window.addEventListener('hashchange', () => void applyHash());

async function copyAndFlash(button: HTMLButtonElement, text: string): Promise<void> {
  const copied = await copyText(text);
  flashButton(button, copied ? 'Copied' : 'Press ⌘C');
}

void applyHash();
