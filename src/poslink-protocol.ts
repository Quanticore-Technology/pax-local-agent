/**
 * PAX POSLink "Low Level Specification" packet codec.
 *
 * This is the protocol BroadPOS actually speaks. The POSLink SDK (.NET / Java /
 * iOS) is only a wrapper around it — platforms without an SDK (Node, in our
 * case) are expected to build these packets directly. Confirmed by PAX support
 * and by their official JavaScript sample (`POSLink JAVAScript Sample`,
 * `js/Pax/pax.js`), which this module reimplements.
 *
 * Packet layout:
 *
 *   STX │ Command │ FS │ Version │ FS │ <group> │ FS │ <group> │ … │ ETX │ LRC
 *
 *   STX = 0x02   start of packet
 *   FS  = 0x1C   separates top-level groups
 *   US  = 0x1F   separates fields WITHIN a group
 *   ETX = 0x03   end of packet
 *   LRC = XOR of every byte after STX, including ETX
 *
 * The finished packet is base64-encoded and sent as the HTTP GET query string:
 *
 *   GET http://<ip>:<port>?<base64>
 *
 * NOTE: there is no length prefix and no XML anywhere in this protocol. Earlier
 * versions of this agent assumed both, which is why no command ever reached the
 * terminal.
 */

export const STX = 0x02;
export const FS = 0x1c;
export const US = 0x1f;
export const ETX = 0x03;

/** Protocol version negotiated in every packet. Matches PAX's sample. */
export const PROTOCOL_VERSION = '1.28';

/** Response code meaning "approved / OK". */
export const SUCCESS_CODE = '000000';

/** Top-level command codes. */
export const COMMAND = {
  INITIALIZE: 'A00',
  GET_SIGNATURE: 'A08',
  DO_SIGNATURE: 'A20',
  DO_CREDIT: 'T00',
  BATCH_CLOSE: 'B00',
} as const;

/** TransactionType values for the T00 (DoCredit) command. */
export const TRANS_TYPE = {
  MENU: '00',
  SALE: '01',
  RETURN: '02',
  AUTH: '03',
  POSTAUTH: '04',
  FORCED: '05',
  ADJUST: '06',
  VOID: '16',
  VOID_SALE: '17',
  VOID_RETURN: '18',
} as const;

/**
 * One top-level group in a packet. A plain string is emitted as-is; an array is
 * emitted as its elements joined by US.
 */
export type PacketGroup = string | string[];

/** XOR every byte from `start` to the end of `buf`. */
function xorFrom(buf: number[], start: number): number {
  let lrc = 0;
  for (let i = start; i < buf.length; i++) lrc ^= buf[i];
  return lrc & 0xff;
}

function pushAscii(out: number[], text: string): void {
  for (const byte of Buffer.from(text, 'ascii')) out.push(byte);
}

/**
 * Render one group's bytes.
 *
 * Empty slots still emit their US separator so later fields keep their
 * position — the terminal identifies fields positionally, not by name. A group
 * whose every field is empty collapses to nothing, matching PAX's sample.
 */
function pushGroup(out: number[], group: PacketGroup): void {
  if (typeof group === 'string') {
    pushAscii(out, group);
    return;
  }

  const tokens: Array<string | number> = [];
  let populated = 0;
  for (const value of group) {
    if (value === '') {
      tokens.push(US);
      continue;
    }
    populated++;
    tokens.push(value);
    tokens.push(US);
  }
  tokens.pop(); // drop the trailing separator

  if (populated === 0) return; // wholly empty group emits nothing

  for (const token of tokens) {
    if (typeof token === 'number') out.push(token);
    else pushAscii(out, token);
  }
}

/**
 * Build a complete packet: STX … ETX + LRC.
 * `groups` are emitted after Command and Version, each preceded by an FS.
 */
export function buildPacket(
  command: string,
  groups: PacketGroup[] = [],
  version: string = PROTOCOL_VERSION,
): Buffer {
  const out: number[] = [STX];
  pushAscii(out, command);
  out.push(FS);
  pushAscii(out, version);

  for (const group of groups) {
    out.push(FS);
    pushGroup(out, group);
  }

  out.push(ETX);
  out.push(xorFrom(out, 1)); // LRC covers everything after STX, ETX included
  return Buffer.from(out);
}

/** Encode a packet for the HTTP GET query string. */
export function encodePacket(packet: Buffer): string {
  return packet.toString('base64');
}

/** Build and encode in one step — what the transport layer actually sends. */
export function buildQuery(
  command: string,
  groups: PacketGroup[] = [],
  version?: string,
): string {
  return encodePacket(buildPacket(command, groups, version));
}

export interface ParsedResponse {
  /** Top-level groups, in order. A group containing US becomes a string[]. */
  fields: Array<string | string[]>;
  /** True when the trailing LRC byte matched our computation. */
  lrcValid: boolean;
}

/**
 * Parse a raw response packet.
 *
 * Throws when the packet is structurally unusable (no STX, no ETX). An LRC
 * mismatch is reported via `lrcValid` rather than thrown — some firmware builds
 * compute it slightly differently and the payload is still readable.
 */
export function parsePacket(raw: Buffer): ParsedResponse {
  if (raw.length < 3) {
    throw new Error(`POSLink response too short: ${raw.length} bytes`);
  }
  const start = raw.indexOf(STX);
  if (start < 0) {
    throw new Error('POSLink response has no STX');
  }
  const etxIndex = raw.indexOf(ETX, start);
  if (etxIndex < 0) {
    throw new Error('POSLink response has no ETX');
  }

  const expectedLrc = xorFrom([...raw.slice(start, etxIndex + 1)], 1);
  const actualLrc = raw.length > etxIndex + 1 ? raw[etxIndex + 1] : -1;

  const body = raw.slice(start + 1, etxIndex);
  const fields = splitOn(body, FS).map((part) => {
    const text = part.toString('ascii');
    return text.includes(String.fromCharCode(US))
      ? splitOn(part, US).map((sub) => sub.toString('ascii'))
      : text;
  });

  return { fields, lrcValid: expectedLrc === actualLrc };
}

function splitOn(buf: Buffer, separator: number): Buffer[] {
  const parts: Buffer[] = [];
  let cursor = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === separator) {
      parts.push(buf.slice(cursor, i));
      cursor = i + 1;
    }
  }
  parts.push(buf.slice(cursor));
  return parts;
}

/** Read a top-level field as a string, tolerating a missing index. */
export function field(parsed: ParsedResponse, index: number): string {
  const value = parsed.fields[index];
  if (value === undefined) return '';
  return Array.isArray(value) ? (value[0] ?? '') : value;
}

/** Read one sub-field out of a US-separated group. */
export function subField(parsed: ParsedResponse, index: number, position: number): string {
  const value = parsed.fields[index];
  if (value === undefined) return '';
  if (!Array.isArray(value)) return position === 0 ? value : '';
  return value[position] ?? '';
}
