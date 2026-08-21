/**
 * The slice of CBOR that COSE needs.
 *
 * Cardano's message signatures are COSE structures, and COSE is CBOR. A full
 * CBOR implementation is a large thing to trust for the handful of shapes that
 * appear here — a four-element array, two small maps, some byte strings — so
 * this decodes definite-length values only and refuses everything else rather
 * than guessing. Anything a real signature does not contain is an error, which
 * is the behaviour you want from a verifier.
 */

export class CborError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CborError';
  }
}

export type CborValue =
  | number
  | string
  | Uint8Array
  | boolean
  | null
  | CborValue[]
  | Map<string | number, CborValue>;

const MAJOR = {
  unsigned: 0,
  negative: 1,
  bytes: 2,
  text: 3,
  array: 4,
  map: 5,
  simple: 7,
} as const;

class CborReader {
  private offset = 0;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get consumed(): number {
    return this.offset;
  }

  private readByte(): number {
    const value = this.bytes[this.offset];
    if (value === undefined) throw new CborError('CBOR data ended unexpectedly.');
    this.offset += 1;
    return value;
  }

  private readBytes(length: number): Uint8Array {
    if (this.offset + length > this.bytes.length) {
      throw new CborError('A CBOR string claims more bytes than are present.');
    }
    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  /** The argument encoded in the initial byte, or in the bytes following it. */
  private readArgument(info: number): number {
    if (info < 24) return info;
    if (info === 24) return this.readByte();
    if (info === 25) return (this.readByte() << 8) | this.readByte();
    if (info === 26) {
      let value = 0;
      for (let i = 0; i < 4; i += 1) value = value * 256 + this.readByte();
      return value;
    }
    if (info === 27) {
      let value = 0;
      for (let i = 0; i < 8; i += 1) value = value * 256 + this.readByte();
      if (!Number.isSafeInteger(value)) throw new CborError('CBOR integer is out of range.');
      return value;
    }
    // 28–30 are reserved; 31 is the indefinite length COSE never uses.
    throw new CborError('Unsupported CBOR length encoding.');
  }

  read(): CborValue {
    const initial = this.readByte();
    const major = initial >> 5;
    const info = initial & 0x1f;

    switch (major) {
      case MAJOR.unsigned:
        return this.readArgument(info);
      case MAJOR.negative:
        return -1 - this.readArgument(info);
      case MAJOR.bytes:
        return this.readBytes(this.readArgument(info));
      case MAJOR.text:
        return new TextDecoder('utf-8', { fatal: false }).decode(
          this.readBytes(this.readArgument(info)),
        );
      case MAJOR.array: {
        const length = this.readArgument(info);
        const items: CborValue[] = [];
        for (let i = 0; i < length; i += 1) items.push(this.read());
        return items;
      }
      case MAJOR.map: {
        const length = this.readArgument(info);
        const entries = new Map<string | number, CborValue>();
        for (let i = 0; i < length; i += 1) {
          const key = this.read();
          if (typeof key !== 'string' && typeof key !== 'number') {
            throw new CborError('CBOR map keys must be integers or text here.');
          }
          entries.set(key, this.read());
        }
        return entries;
      }
      case MAJOR.simple:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        throw new CborError('Unsupported CBOR simple value.');
      default:
        throw new CborError('Unsupported CBOR major type.');
    }
  }
}

/** Decodes one CBOR value, rejecting anything left over after it. */
export function decodeCbor(bytes: Uint8Array): CborValue {
  const reader = new CborReader(bytes);
  const value = reader.read();
  if (reader.consumed !== bytes.length) {
    throw new CborError('Trailing bytes after the CBOR value.');
  }
  return value;
}

function encodeHead(major: number, length: number): Uint8Array {
  if (length < 24) return Uint8Array.of((major << 5) | length);
  if (length < 0x100) return Uint8Array.of((major << 5) | 24, length);
  if (length < 0x10000) return Uint8Array.of((major << 5) | 25, length >> 8, length & 0xff);
  return Uint8Array.of(
    (major << 5) | 26,
    (length >>> 24) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
  );
}

export function encodeArrayHeader(length: number): Uint8Array {
  return encodeHead(MAJOR.array, length);
}

function encodeString(major: number, value: Uint8Array): Uint8Array {
  const head = encodeHead(major, value.length);
  const out = new Uint8Array(head.length + value.length);
  out.set(head);
  out.set(value, head.length);
  return out;
}

export function encodeBytes(value: Uint8Array): Uint8Array {
  return encodeString(MAJOR.bytes, value);
}

export function encodeText(value: string): Uint8Array {
  return encodeString(MAJOR.text, new TextEncoder().encode(value));
}
