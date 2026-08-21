/**
 * Colour theme, chosen explicitly rather than inherited from the operating
 * system. Dark is the default and is what the stylesheet paints without any
 * attribute set, so the only state worth persisting is a deliberate switch to
 * light.
 */

export type Theme = 'dark' | 'light';

export const defaultTheme: Theme = 'dark';

/** Also read by the pre-paint script in index.html; change both together. */
const STORAGE_KEY = 'proof-of-ownership:theme';

function isTheme(value: unknown): value is Theme {
  return value === 'dark' || value === 'light';
}

/**
 * Storage throws rather than returning null when a browser blocks it — Safari
 * in private mode, or a profile with site data disabled — and a theme
 * preference is never worth breaking the page over.
 */
export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isTheme(stored)) return stored;
  } catch {
    // Fall through to the default.
  }
  return defaultTheme;
}

export function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // The choice still applies to this page, it just will not outlive it.
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset['theme'] = theme;
}
