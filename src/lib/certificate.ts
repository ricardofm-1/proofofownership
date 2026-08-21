/**
 * Shared types and text helpers for the locally generated proof PDF.
 *
 * The PDF itself is drawn in `pdf.ts`; this file stays free of `pdf-lib` so
 * wrapping and filename rules can be tested without building a document.
 */

import type { ChainId } from '../chains/types.ts';

export type ProofKind = 'signed' | 'verified';

export interface ProofCertificate {
  kind: ProofKind;
  chainId: ChainId;
  chainName: string;
  signingStandard: string;
  address: string;
  message: string;
  signature: string;
  generatedAt: Date;
}

/**
 * Windows-1252 extras that PDF standard fonts can draw, plus the Latin-1
 * block. Everything else has to be substituted: Helvetica cannot encode it,
 * and shipping a Unicode font would dwarf the rest of the page.
 */
const WINANSI_EXTRAS = new Set<number>([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160,
  0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

export function isWinAnsiCodePoint(code: number): boolean {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
  if (code >= 0x20 && code <= 0x7e) return true;
  if (code >= 0xa0 && code <= 0xff) return true;
  return WINANSI_EXTRAS.has(code);
}

/**
 * Returns a string PDF standard fonts can draw, and whether any character
 * had to be replaced. Callers must surface the substitution: the signature
 * was computed over the original bytes, not over this rendering.
 */
export function toWinAnsi(text: string): { text: string; substituted: boolean } {
  let substituted = false;
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    if (code === 0x09) {
      out += '  ';
      continue;
    }
    if (isWinAnsiCodePoint(code)) {
      out += char;
      continue;
    }
    out += '?';
    substituted = true;
  }
  return { text: out, substituted };
}

/**
 * Wraps `text` so each line measures at most `maxWidth`. Existing newlines
 * are kept. A single token wider than the measure (a signature, typically)
 * is split mid-character rather than overflowing the page.
 */
export function wrapLines(
  text: string,
  maxWidth: number,
  measure: (line: string) => number,
): string[] {
  const paragraphs = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) {
      lines.push('');
      continue;
    }

    let remaining = paragraph;
    while (remaining.length > 0) {
      if (measure(remaining) <= maxWidth) {
        lines.push(remaining);
        break;
      }

      let lo = 1;
      let hi = remaining.length;
      let fit = 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (measure(remaining.slice(0, mid)) <= maxWidth) {
          fit = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }

      const slice = remaining.slice(0, fit);
      let breakAt = fit;
      if (fit < remaining.length && remaining.charAt(fit) !== ' ') {
        const space = slice.lastIndexOf(' ');
        if (space > 0) breakAt = space;
      }
      lines.push(remaining.slice(0, breakAt).trimEnd());
      remaining = remaining.slice(breakAt).trimStart();
    }
  }

  return lines.length > 0 ? lines : [''];
}

export function certificateFilename(input: Pick<ProofCertificate, 'chainId' | 'kind'>): string {
  return `proof-of-ownership-${input.chainId}-${input.kind}.pdf`;
}
