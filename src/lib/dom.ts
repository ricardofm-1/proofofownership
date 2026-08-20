/** Typed `querySelector` that fails loudly instead of returning null downstream. */
export function el<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`Missing required element: ${selector}`);
  return found;
}

export function elAll<T extends Element = HTMLElement>(
  selector: string,
  root: ParentNode = document,
): T[] {
  return [...root.querySelectorAll<T>(selector)];
}

/** Middle-truncates an address so both ends stay recognisable. */
export function truncateAddress(address: string, lead = 6, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

/**
 * Copies text, falling back to a hidden textarea for non-secure contexts
 * (plain http on a LAN address, for instance) where the async API is missing.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Briefly swaps a button's label to confirm an action without a toast system. */
export function flashButton(button: HTMLButtonElement, label: string, ms = 1400): void {
  const original = button.dataset['originalLabel'] ?? button.textContent ?? '';
  button.dataset['originalLabel'] = original;
  button.textContent = label;
  button.classList.add('is-flashing');
  window.clearTimeout(Number(button.dataset['flashTimer'] ?? 0));
  const timer = window.setTimeout(() => {
    button.textContent = button.dataset['originalLabel'] ?? original;
    button.classList.remove('is-flashing');
  }, ms);
  button.dataset['flashTimer'] = String(timer);
}
