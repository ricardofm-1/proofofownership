/**
 * Builds a scannable QR SVG in the browser. `uqr` is MIT-licensed and is
 * loaded only when someone opens a donation QR, the same way WalletConnect
 * and the PDF builder stay off the first paint.
 */
export async function qrSvgForText(text: string): Promise<string> {
  const { renderSVG } = await import('uqr');
  return renderSVG(text, {
    ecc: 'M',
    border: 2,
    pixelSize: 8,
    whiteColor: '#ffffff',
    blackColor: '#111111',
  });
}
