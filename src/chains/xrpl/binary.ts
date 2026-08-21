/**
 * A reader for the XRP Ledger's binary transaction format.
 *
 * Verifying an XRPL signature means reconstructing the exact bytes that were
 * signed, and those bytes are the transaction itself with its signature fields
 * removed. So the reader has to walk every field of an arbitrary transaction,
 * even field types this tool has no interest in, purely to know where each one
 * ends. Field lengths are not stored anywhere: they follow from the type code
 * in each field's header, which is why the type table below has to be complete.
 *
 * Every field keeps a slice of the original bytes. Rebuilding the signed
 * payload is then a matter of dropping the signature fields and concatenating
 * what remains, which sidesteps re-serialising — and re-deriving the canonical
 * field order — entirely.
 */

import { concatBytes } from '../../lib/bytes.ts';

export class XrplParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XrplParseError';
  }
}

const TYPE = {
  uint16: 1,
  uint32: 2,
  uint64: 3,
  hash128: 4,
  hash256: 5,
  amount: 6,
  blob: 7,
  accountId: 8,
  number: 9,
  stObject: 14,
  stArray: 15,
  uint8: 16,
  hash160: 17,
  pathSet: 18,
  vector256: 19,
  uint96: 20,
  hash192: 21,
  hash384: 22,
  hash512: 23,
  issue: 24,
  xChainBridge: 25,
  currency: 26,
} as const;

/** Types whose payload is preceded by a variable-length prefix. */
const VARIABLE_LENGTH: ReadonlySet<number> = new Set([
  TYPE.blob,
  TYPE.accountId,
  TYPE.vector256,
]);

const FIXED_WIDTH: ReadonlyMap<number, number> = new Map([
  [TYPE.uint8, 1],
  [TYPE.uint16, 2],
  [TYPE.uint32, 4],
  [TYPE.uint64, 8],
  [TYPE.number, 12],
  [TYPE.uint96, 12],
  [TYPE.hash128, 16],
  [TYPE.hash160, 20],
  [TYPE.currency, 20],
  [TYPE.hash192, 24],
  [TYPE.hash256, 32],
  [TYPE.hash384, 48],
  [TYPE.hash512, 64],
]);

/** A field identified as `<type code>:<field code>`. */
export type FieldKey = string;

export const FIELD = {
  transactionType: '1:2',
  sequence: '2:4',
  fee: '6:8',
  signingPubKey: '7:3',
  txnSignature: '7:4',
  memoType: '7:12',
  memoData: '7:13',
  memoFormat: '7:14',
  account: '8:1',
  memos: '15:9',
} as const;

/**
 * Fields rippled marks as non-signing. They are excluded from the bytes a
 * signature commits to — a signature obviously cannot cover itself.
 */
const NON_SIGNING_FIELDS: ReadonlySet<FieldKey> = new Set([
  '7:4', // TxnSignature
  '7:6', // Signature
  '7:18', // MasterSignature
  '14:37', // CounterpartySignature
  '14:38', // SponsorSignature
  '15:3', // Signers
  '15:31', // BatchSigners
]);

export interface XrplField {
  key: FieldKey;
  typeCode: number;
  fieldCode: number;
  /** The field's payload, without header or length prefix. */
  value: Uint8Array;
  /** The field exactly as it appeared, header and all. */
  raw: Uint8Array;
}

class Reader {
  private offset = 0;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get position(): number {
    return this.offset;
  }

  get exhausted(): boolean {
    return this.offset >= this.bytes.length;
  }

  slice(start: number, end: number): Uint8Array {
    return this.bytes.slice(start, end);
  }

  byteAt(index: number): number {
    const value = this.bytes[index];
    if (value === undefined) throw new XrplParseError('Transaction data ends mid-field.');
    return value;
  }

  peek(): number {
    return this.byteAt(this.offset);
  }

  readByte(): number {
    const value = this.byteAt(this.offset);
    this.offset += 1;
    return value;
  }

  take(length: number): Uint8Array {
    if (length < 0 || this.offset + length > this.bytes.length) {
      throw new XrplParseError('A field claims more bytes than the transaction contains.');
    }
    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  /**
   * Field headers pack a type code and a field code into as few bytes as
   * possible: both fit in one byte when each is under 16, otherwise the
   * oversized one spills into a following byte.
   */
  readHeader(): { typeCode: number; fieldCode: number } {
    const first = this.readByte();
    let typeCode = first >> 4;
    let fieldCode = first & 0x0f;

    if (typeCode === 0) {
      typeCode = this.readByte();
      if (typeCode < 16) throw new XrplParseError('Field header has an out-of-range type code.');
    }
    if (fieldCode === 0) {
      fieldCode = this.readByte();
      if (fieldCode < 16) throw new XrplParseError('Field header has an out-of-range field code.');
    }
    return { typeCode, fieldCode };
  }

  readVariableLength(): number {
    const first = this.readByte();
    if (first <= 192) return first;
    if (first <= 240) return 193 + (first - 193) * 256 + this.readByte();
    if (first <= 254) {
      const second = this.readByte();
      const third = this.readByte();
      return 12481 + (first - 241) * 65536 + second * 256 + third;
    }
    throw new XrplParseError('Invalid length prefix.');
  }

  /** Issues are 20 bytes for XRP, 40 with an issuer, 44 for a multi-purpose token. */
  private issueWidth(): number {
    const currency = this.bytes.slice(this.offset, this.offset + 20);
    if (currency.length < 20) throw new XrplParseError('Truncated issue.');
    if (currency.every((byte) => byte === 0)) return 20;

    const issuer = this.bytes.slice(this.offset + 20, this.offset + 40);
    if (issuer.length < 20) throw new XrplParseError('Truncated issue.');
    const isPlaceholderIssuer =
      issuer.slice(0, 19).every((byte) => byte === 0) && issuer[19] === 1;
    return isPlaceholderIssuer ? 44 : 40;
  }

  readValue(typeCode: number): Uint8Array {
    if (VARIABLE_LENGTH.has(typeCode)) return this.take(this.readVariableLength());

    const width = FIXED_WIDTH.get(typeCode);
    if (width !== undefined) return this.take(width);

    if (typeCode === TYPE.amount) {
      const lead = this.peek();
      if (lead & 0x80) return this.take(48); // issued currency
      return this.take(lead & 0x20 ? 33 : 8); // multi-purpose token, else XRP drops
    }

    if (typeCode === TYPE.issue) return this.take(this.issueWidth());

    if (typeCode === TYPE.xChainBridge) {
      const start = this.offset;
      // A locking chain door and issue, then an issuing chain door and issue.
      for (let side = 0; side < 2; side += 1) {
        this.take(1); // the door account's length prefix, always 20
        this.take(20);
        this.take(this.issueWidth());
      }
      return this.slice(start, this.offset);
    }

    // Paths are a list of steps, each step's byte saying which of account,
    // currency and issuer follow. 0xff starts another path, 0x00 ends the set.
    if (typeCode === TYPE.pathSet) {
      const start = this.offset;
      for (;;) {
        const step = this.readByte();
        if (step === 0x00) break;
        if (step === 0xff) continue;
        if (step & 0x01) this.take(20);
        if (step & 0x10) this.take(20);
        if (step & 0x20) this.take(20);
      }
      return this.slice(start, this.offset);
    }

    if (typeCode === TYPE.stObject || typeCode === TYPE.stArray) {
      const start = this.offset;
      for (;;) {
        const beforeHeader = this.offset;
        const header = this.readHeader();
        // Both containers close with their own type code and field code 1. The
        // marker stays out of the value so the contents can be parsed as a
        // field stream in their own right, but the caller's `raw` still spans
        // it and so still round-trips.
        if (header.typeCode === typeCode && header.fieldCode === 1) {
          return this.slice(start, beforeHeader);
        }
        this.readValue(header.typeCode);
      }
    }

    throw new XrplParseError(`Unsupported field type ${typeCode}.`);
  }
}

/** Walks a serialised transaction, returning its fields in the order stored. */
export function parseFields(bytes: Uint8Array): XrplField[] {
  const reader = new Reader(bytes);
  const fields: XrplField[] = [];

  while (!reader.exhausted) {
    const start = reader.position;
    const { typeCode, fieldCode } = reader.readHeader();
    const value = reader.readValue(typeCode);
    fields.push({
      key: `${typeCode}:${fieldCode}`,
      typeCode,
      fieldCode,
      value,
      raw: reader.slice(start, reader.position),
    });
  }

  if (fields.length === 0) throw new XrplParseError('The transaction contains no fields.');
  return fields;
}

export function findField(fields: readonly XrplField[], key: FieldKey): Uint8Array | null {
  return fields.find((field) => field.key === key)?.value ?? null;
}

/**
 * The bytes a single-signature commits to: every signing field, in the order
 * they were serialised, behind rippled's `STX\0` prefix. The prefix is what
 * stops a transaction signature being replayed as a validation or a proposal.
 */
export function singleSigningData(fields: readonly XrplField[]): Uint8Array {
  const signed = fields.filter((field) => !NON_SIGNING_FIELDS.has(field.key));
  return concatBytes(Uint8Array.of(0x53, 0x54, 0x58, 0x00), ...signed.map((field) => field.raw));
}

/** Reads the memos out of a transaction, decoding each payload as UTF-8. */
export function readMemos(fields: readonly XrplField[]): string[] {
  const memos = fields.find((field) => field.key === FIELD.memos);
  if (!memos) return [];

  const decoder = new TextDecoder('utf-8', { fatal: false });
  const contents: string[] = [];
  // The array's payload is a run of Memo objects, each a normal field stream.
  for (const field of parseFields(memos.value)) {
    if (field.typeCode !== 14) continue;
    const data = findField(parseFields(field.value), FIELD.memoData);
    if (data) contents.push(decoder.decode(data));
  }
  return contents;
}
