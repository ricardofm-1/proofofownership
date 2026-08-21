/**
 * Builds a proof PDF entirely in the browser.
 *
 * Colours are the light-theme tokens from `styles.css`, used regardless of
 * the page's current theme: a document that prints black-on-cream is readable
 * on paper and in a mail client, and the light palette is the one designed
 * for that. `pdf-lib` is MIT-licensed and is loaded only when a PDF is
 * requested, the same way WalletConnect is loaded only when chosen.
 */

import { PDFDocument, StandardFonts, rgb, degrees, type PDFFont, type PDFPage } from 'pdf-lib';

import {
  certificateFilename,
  toWinAnsi,
  wrapLines,
  type ProofCertificate,
} from './certificate.ts';

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 48;
const FOOTER = 52;
const GUTTER = PAGE.width - MARGIN * 2;

const color = {
  bg: rgb(242 / 255, 242 / 255, 239 / 255),
  surface: rgb(251 / 255, 251 / 255, 250 / 255),
  ink: rgb(22 / 255, 23 / 255, 27 / 255),
  muted: rgb(95 / 255, 100 / 255, 109 / 255),
  faint: rgb(139 / 255, 144 / 255, 154 / 255),
  line: rgb(222 / 255, 222 / 255, 218 / 255),
  lineStrong: rgb(198 / 255, 198 / 255, 191 / 255),
  valid: rgb(15 / 255, 107 / 255, 65 / 255),
  validSoft: rgb(231 / 255, 242 / 255, 234 / 255),
  validLine: rgb(168 / 255, 204 / 255, 182 / 255),
};

interface Fonts {
  sans: PDFFont;
  sansBold: PDFFont;
  mono: PDFFont;
}

interface Painter {
  pdf: PDFDocument;
  fonts: Fonts;
  page: PDFPage;
  pageNumber: number;
  y: number;
  substituted: boolean;
}

function measure(font: PDFFont, size: number, text: string): number {
  return font.widthOfTextAtSize(text, size);
}

function prepare(text: string): { text: string; substituted: boolean } {
  return toWinAnsi(text);
}

function addPage(pdf: PDFDocument): PDFPage {
  const page = pdf.addPage([PAGE.width, PAGE.height]);
  page.drawRectangle({
    x: 0,
    y: 0,
    width: PAGE.width,
    height: PAGE.height,
    color: color.bg,
  });
  return page;
}

function drawHeader(painter: Painter, continued: boolean): void {
  const { page, fonts } = painter;
  const top = PAGE.height - MARGIN;

  const cx = MARGIN + 11;
  const cy = top - 11;
  const s = 11 / 16;
  page.drawCircle({
    x: cx,
    y: cy,
    size: 11,
    borderColor: color.ink,
    borderWidth: 1,
  });
  page.drawCircle({
    x: cx,
    y: cy,
    size: 7.5,
    borderColor: color.ink,
    borderWidth: 0.6,
    borderDashArray: [1.2, 1.4],
  });
  // SVG y grows down; PDF y grows up. The site wordmark path is
  // M11 16.2 L14.6 20 L21.4 12.4 in a 32×32 viewBox centred on (16,16).
  page.drawLine({
    start: { x: cx + (11 - 16) * s, y: cy - (16.2 - 16) * s },
    end: { x: cx + (14.6 - 16) * s, y: cy - (20 - 16) * s },
    thickness: 1.4,
    color: color.ink,
  });
  page.drawLine({
    start: { x: cx + (14.6 - 16) * s, y: cy - (20 - 16) * s },
    end: { x: cx + (21.4 - 16) * s, y: cy - (12.4 - 16) * s },
    thickness: 1.4,
    color: color.ink,
  });

  page.drawText('Proof of Ownership', {
    x: MARGIN + 28,
    y: top - 10,
    size: 13,
    font: fonts.sansBold,
    color: color.ink,
  });
  page.drawText(
    continued ? 'Sign & verify wallet messages  ·  continued' : 'Sign & verify wallet messages',
    {
      x: MARGIN + 28,
      y: top - 24,
      size: 9,
      font: fonts.sans,
      color: color.muted,
    },
  );

  page.drawLine({
    start: { x: MARGIN, y: top - 36 },
    end: { x: PAGE.width - MARGIN, y: top - 36 },
    thickness: 0.6,
    color: color.line,
  });

  painter.y = top - 52;
}

function drawFooter(painter: Painter, pageCount: number): void {
  const { page, fonts, pageNumber } = painter;
  const y = MARGIN - 6;

  page.drawLine({
    start: { x: MARGIN, y: FOOTER + 8 },
    end: { x: PAGE.width - MARGIN, y: FOOTER + 8 },
    thickness: 0.6,
    color: color.line,
  });

  page.drawText('Generated in this browser. Nothing was uploaded or stored.', {
    x: MARGIN,
    y,
    size: 7.5,
    font: fonts.sans,
    color: color.faint,
  });
  const label = `${pageNumber} / ${pageCount}`;
  const width = measure(fonts.sans, 7.5, label);
  page.drawText(label, {
    x: PAGE.width - MARGIN - width,
    y,
    size: 7.5,
    font: fonts.sans,
    color: color.faint,
  });
}

function newPage(painter: Painter): void {
  painter.page = addPage(painter.pdf);
  painter.pageNumber += 1;
  drawHeader(painter, true);
}

function ensure(painter: Painter, needed: number): void {
  if (painter.y - needed < MARGIN + FOOTER) newPage(painter);
}

function drawStamp(painter: Painter, chainName: string): void {
  const cx = PAGE.width - MARGIN - 46;
  const cy = painter.y - 10;
  const { page, fonts } = painter;

  page.drawCircle({
    x: cx,
    y: cy,
    size: 38,
    borderColor: color.valid,
    borderWidth: 1.6,
  });
  page.drawCircle({
    x: cx,
    y: cy,
    size: 32,
    borderColor: color.valid,
    borderWidth: 0.7,
    borderDashArray: [1.6, 1.8],
  });

  const main = 'VERIFIED';
  const mainSize = 8;
  const mainWidth = measure(fonts.sansBold, mainSize, main);
  page.drawText(main, {
    x: cx - mainWidth / 2,
    y: cy + 1,
    size: mainSize,
    font: fonts.sansBold,
    color: color.valid,
    rotate: degrees(-9),
  });

  const sub = prepare(chainName).text.toUpperCase();
  const subSize = 6;
  const subWidth = measure(fonts.mono, subSize, sub);
  page.drawText(sub, {
    x: cx - subWidth / 2,
    y: cy - 10,
    size: subSize,
    font: fonts.mono,
    color: color.valid,
    rotate: degrees(-9),
  });
}

function drawBanner(painter: Painter, input: ProofCertificate): void {
  const verified = input.kind === 'verified';
  const title = verified ? 'Valid signature' : 'Signed message';
  const detail = verified
    ? `Checked with ${input.signingStandard}, entirely in this browser.`
    : `Signed with ${input.signingStandard}. Off-chain: no transaction, no fee.`;

  const prepared = prepare(detail);
  painter.substituted ||= prepared.substituted;
  const detailWidth = GUTTER - (verified ? 110 : 28);
  const detailLines = wrapLines(prepared.text, detailWidth, (line) =>
    measure(painter.fonts.sans, 8.5, line),
  );

  const height = 36 + detailLines.length * 11;
  ensure(painter, height + 8);
  const { page, fonts } = painter;
  const y = painter.y - height;

  page.drawRectangle({
    x: MARGIN,
    y,
    width: GUTTER,
    height,
    color: verified ? color.validSoft : color.surface,
    borderColor: verified ? color.validLine : color.lineStrong,
    borderWidth: 0.8,
  });
  if (!verified) {
    page.drawRectangle({
      x: MARGIN,
      y,
      width: 3,
      height,
      color: color.ink,
    });
  }

  page.drawText(title, {
    x: MARGIN + 14,
    y: y + height - 18,
    size: 13,
    font: fonts.sansBold,
    color: verified ? color.valid : color.ink,
  });

  let detailY = y + height - 32;
  for (const line of detailLines) {
    page.drawText(line, {
      x: MARGIN + 14,
      y: detailY,
      size: 8.5,
      font: fonts.sans,
      color: color.muted,
    });
    detailY -= 11;
  }

  if (verified) drawStamp(painter, input.chainName);

  painter.y = y - 18;
}

function drawField(
  painter: Painter,
  label: string,
  value: string,
  options: { mono: boolean; size: number },
): void {
  const prepared = prepare(value);
  painter.substituted ||= prepared.substituted;

  const font = options.mono ? painter.fonts.mono : painter.fonts.sans;
  const size = options.size;
  const lineHeight = size + 4;
  const inner = 10;
  const boxWidth = GUTTER - inner * 2;
  let remaining = wrapLines(prepared.text, boxWidth, (line) => measure(font, size, line));
  let heading = label;

  while (remaining.length > 0) {
    const labelSpace = 14;
    const available = painter.y - (MARGIN + FOOTER) - labelSpace;
    const minBox = inner * 2 + lineHeight;
    if (available < minBox) {
      newPage(painter);
      continue;
    }

    const maxLines = Math.max(1, Math.floor((available - inner * 2) / lineHeight));
    const chunk = remaining.slice(0, maxLines);
    remaining = remaining.slice(maxLines);
    const boxHeight = inner * 2 + chunk.length * lineHeight;

    const { page, fonts } = painter;
    page.drawText(heading, {
      x: MARGIN,
      y: painter.y - 8,
      size: 7.5,
      font: fonts.sansBold,
      color: color.faint,
    });
    painter.y -= labelSpace;

    const boxY = painter.y - boxHeight;
    page.drawRectangle({
      x: MARGIN,
      y: boxY,
      width: GUTTER,
      height: boxHeight,
      color: color.surface,
      borderColor: color.line,
      borderWidth: 0.6,
    });

    let textY = boxY + boxHeight - inner - size;
    for (const line of chunk) {
      page.drawText(line.length === 0 ? ' ' : line, {
        x: MARGIN + inner,
        y: textY,
        size,
        font,
        color: color.ink,
      });
      textY -= lineHeight;
    }

    painter.y = boxY - 14;
    heading = `${label} (continued)`;
  }
}

function drawNotes(painter: Painter, input: ProofCertificate): void {
  const generated = input.generatedAt.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const notes = [
    `Document generated ${generated}. That is when this file was written, not when the message was signed.`,
    'www.proofofownership.com',
  ];
  if (painter.substituted) {
    notes.unshift(
      'Some characters in the original message cannot be drawn in this PDF font and were replaced with "?". The signature covers the original bytes; re-verify in the tool with the original text.',
    );
  }

  const size = 7.5;
  const lineHeight = 11;
  const font = painter.fonts.sans;
  const lines = notes.flatMap((note) => wrapLines(prepare(note).text, GUTTER, (line) => measure(font, size, line)));

  ensure(painter, 12 + lines.length * lineHeight);
  painter.y -= 6;
  painter.page.drawLine({
    start: { x: MARGIN, y: painter.y },
    end: { x: PAGE.width - MARGIN, y: painter.y },
    thickness: 0.6,
    color: color.line,
  });
  painter.y -= 14;

  for (const line of lines) {
    ensure(painter, lineHeight);
    painter.page.drawText(line, {
      x: MARGIN,
      y: painter.y,
      size,
      font,
      color: color.muted,
    });
    painter.y -= lineHeight;
  }
}

export async function buildProofPdf(input: ProofCertificate): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(
    input.kind === 'verified'
      ? `Proof of Ownership — valid ${input.chainName} signature`
      : `Proof of Ownership — signed ${input.chainName} message`,
  );
  pdf.setAuthor('Proof of Ownership');
  pdf.setCreator('Proof of Ownership (generated locally in the browser)');
  pdf.setCreationDate(input.generatedAt);
  pdf.setModificationDate(input.generatedAt);

  const fonts: Fonts = {
    sans: await pdf.embedFont(StandardFonts.Helvetica),
    sansBold: await pdf.embedFont(StandardFonts.HelveticaBold),
    mono: await pdf.embedFont(StandardFonts.Courier),
  };

  const painter: Painter = {
    pdf,
    fonts,
    page: addPage(pdf),
    pageNumber: 1,
    y: 0,
    substituted: false,
  };
  drawHeader(painter, false);
  drawBanner(painter, input);

  drawField(painter, 'CHAIN', input.chainName, { mono: false, size: 10 });
  drawField(painter, 'STANDARD', input.signingStandard, { mono: false, size: 9 });
  drawField(painter, 'ADDRESS', input.address, { mono: true, size: 9 });
  drawField(painter, 'MESSAGE', input.message, { mono: true, size: 9 });
  drawField(painter, 'SIGNATURE', input.signature, { mono: true, size: 8 });
  drawNotes(painter, input);

  const pageCount = pdf.getPageCount();
  // Footers need the final count; they are drawn after the body so a long
  // signature can still add pages without the numbers being off by one.
  for (let index = 0; index < pageCount; index += 1) {
    const page = pdf.getPage(index);
    const numbered: Painter = {
      ...painter,
      page,
      pageNumber: index + 1,
    };
    drawFooter(numbered, pageCount);
  }

  return pdf.save();
}

export async function downloadProofPdf(input: ProofCertificate): Promise<void> {
  const bytes = await buildProofPdf(input);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const blob = new Blob([buffer], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = certificateFilename(input);
  link.click();
  URL.revokeObjectURL(url);
}
