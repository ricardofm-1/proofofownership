/**
 * Byte helpers for Bitcoin's serialisation formats.
 *
 * Bitcoin encodes almost everything little-endian with compact-size length
 * prefixes, which is unlike the other chains here, so the primitives live in
 * one place rather than being re-derived at each call site.
 */

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const array of arrays) total += array.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const array of arrays) {
    out.set(array, offset);
    offset += array.length;
  }
  return out;
}

export function uint32LE(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

export function uint64LE(value: number | bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
  return bytes;
}

/** Bitcoin's compact-size integer. */
export function varInt(value: number): Uint8Array {
  if (value < 0xfd) return Uint8Array.of(value);
  if (value <= 0xffff) return concatBytes(Uint8Array.of(0xfd), uint32LE(value).slice(0, 2));
  return concatBytes(Uint8Array.of(0xfe), uint32LE(value));
}

/** Length-prefixed byte string, as used for scripts and witness items. */
export function varBytes(bytes: Uint8Array): Uint8Array {
  return concatBytes(varInt(bytes.length), bytes);
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(value: string): Uint8Array | null {
  const body = value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
  if (body.length === 0 || body.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(body)) return null;
  const bytes = new Uint8Array(body.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/** Reverses a txid into the byte order block explorers display. */
export function reverseBytes(bytes: Uint8Array): Uint8Array {
  return bytes.slice().reverse();
}
