/**
 * POSLink XML client — talks to a PAX A920 on the LAN.
 *
 * Two transports are supported, selected per device via the `transport`
 * option (default: 'http'):
 *
 *   - 'http' — plaintext HTTP POST. Requires PAX firmware that exposes
 *     POSLink over HTTP (newer BroadPOS builds; salons that can find a
 *     "HTTP" toggle in BroadPOS → Communication → External mode).
 *
 *   - 'tcp'  — raw POSLink TCP framing. Frame layout per PAX SDK:
 *         STX(0x02) | LEN_HI | LEN_LO | <XML bytes> | ETX(0x03) | LRC
 *     where LRC = XOR(LEN_HI, LEN_LO, ...XML, ETX). This works on every
 *     PAX A920 BroadPOS firmware regardless of whether HTTP mode exists.
 *     LEN is sent BIG-ENDIAN — matching the official PAX Android SDK.
 *
 * XML build/parse helpers lifted from the original backend adapter; the relay
 * design moves them here because only the agent has LAN reachability to the
 * device.
 */
import net from 'net';
import { getLogger } from './logger';
import type { PaxResult } from './protocol/messages';

const PAX_SUCCESS_CODE = '000000';
const STX = 0x02;
const ETX = 0x03;

export type PaxTransport = 'http' | 'tcp';

export interface PaxRawResponse {
  resultCode: string;
  resultText: string;
  refNum: string;
  authCode: string;
  cardType: string;
  lastFour: string;
  approvedAmount: string;
  extData: string;
}

export interface PaxClientOptions {
  ip: string;
  port: number;
  /** request timeout (ms) */
  timeoutMs: number;
  /** Wire transport. Defaults to 'http' for backward-compat with v0.3.x
   *  configs that don't carry the field. */
  transport?: PaxTransport;
}

const logger = getLogger();

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** ExtData is passed as raw XML; all other fields are escaped. */
export function buildPosLinkXml(transType: string, fields: Record<string, string> = {}): string {
  const parts = Object.entries(fields).map(([key, value]) => {
    const content = key === 'ExtData' ? value : escapeXml(value);
    return `<${key}>${content}</${key}>`;
  });
  return `<POSLINK><Transaction><TransType>${transType}</TransType>${parts.join('')}</Transaction></POSLINK>`;
}

export function parsePosLinkResponse(xml: string): PaxRawResponse {
  // Use non-greedy match to handle ExtData (which contains nested tags). The
  // previous `[^<]*` pattern would stop at the first nested `<` and return
  // empty for ExtData on real-device responses, causing tip parsing to break.
  const getField = (fieldName: string): string => {
    const match = xml.match(new RegExp(`<${fieldName}>([\\s\\S]*?)</${fieldName}>`));
    return match?.[1] || '';
  };
  return {
    resultCode: getField('ResultCode'),
    resultText: getField('ResultTxt'),
    refNum: getField('RefNum'),
    authCode: getField('AuthCode'),
    cardType: getField('CardType'),
    lastFour: getField('LastFour'),
    approvedAmount: getField('ApprovedAmount'),
    extData: getField('ExtData'),
  };
}

export function getExtDataField(extData: string, tag: string): string {
  if (!extData) return '';
  // Non-greedy match — same fix as parsePosLinkResponse for nested ExtData.
  const match = extData.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return match?.[1] || '';
}

/** Convert raw POSLink response → typed PaxResult (the wire-protocol shape). */
export function toPaxResult(raw: PaxRawResponse, baseAmountCents: number): PaxResult {
  const approvedCents = parseInt(raw.approvedAmount || '0', 10) || 0;
  const extTipStr = getExtDataField(raw.extData, 'TipAmount') || getExtDataField(raw.extData, 'Tip1');
  const extTipCents = parseInt(extTipStr || '0', 10) || 0;
  let tipCents = extTipCents;
  if (!tipCents && approvedCents > baseAmountCents) {
    tipCents = approvedCents - baseAmountCents;
  }
  return {
    result_code: raw.resultCode,
    result_text: raw.resultText,
    ref_num: raw.refNum,
    auth_code: raw.authCode,
    card_type: raw.cardType,
    last_four: raw.lastFour,
    approved_amount_cents: approvedCents,
    tip_amount_cents: tipCents > 0 ? tipCents : 0,
    // PCI: deliberately NOT including raw.extData — it can carry MaskedPAN,
    // EMVData, ICC and other chip-track data depending on PAX firmware. We
    // already extracted the only fields we need (TipAmount/Tip1) above.
    raw_response: {
      resultCode: raw.resultCode,
      resultText: raw.resultText,
      refNum: raw.refNum,
      authCode: raw.authCode,
      cardType: raw.cardType,
      lastFour: raw.lastFour,
      approvedAmount: raw.approvedAmount,
    },
  };
}

/** Send a POSLink XML command, return parsed response. Routes to HTTP or
 *  TCP based on `opts.transport`; defaults to HTTP for backward compat. */
export async function sendPosLinkCommand(
  opts: PaxClientOptions,
  xml: string,
): Promise<PaxRawResponse> {
  if (opts.transport === 'tcp') {
    return sendPosLinkTcp(opts, xml);
  }
  return sendPosLinkHttp(opts, xml);
}

/** HTTP transport. */
async function sendPosLinkHttp(
  opts: PaxClientOptions,
  xml: string,
): Promise<PaxRawResponse> {
  const url = `http://${opts.ip}:${opts.port}`;
  logger.info({ url, timeoutMs: opts.timeoutMs }, 'pax http POST');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml' },
      body: xml,
      signal: controller.signal,
    });
    const text = await response.text();
    logger.debug({ body: text.substring(0, 1000) }, 'pax http response (raw)');
    return parsePosLinkResponse(text);
  } finally {
    clearTimeout(timer);
  }
}

/** Build a POSLink TCP frame: STX | LEN_HI | LEN_LO | DATA | ETX | LRC */
export function buildPosLinkTcpFrame(xml: string): Buffer {
  const data = Buffer.from(xml, 'utf8');
  const lenHi = (data.length >> 8) & 0xff;
  const lenLo = data.length & 0xff;
  // LRC = XOR of every byte EXCEPT STX.
  let lrc = lenHi ^ lenLo ^ ETX;
  for (const b of data) lrc ^= b;
  return Buffer.concat([
    Buffer.from([STX, lenHi, lenLo]),
    data,
    Buffer.from([ETX, lrc & 0xff]),
  ]);
}

/** Parse a TCP-framed response and return its XML payload.
 *  Validates STX/ETX framing; logs (but tolerates) LRC mismatch since some
 *  PAX firmware variants compute LRC slightly differently. Throws when the
 *  frame is structurally broken so the caller fails fast. */
export function parsePosLinkTcpFrame(buf: Buffer): string {
  if (buf.length < 5) throw new Error(`PAX TCP frame too short: ${buf.length} bytes`);
  if (buf[0] !== STX) throw new Error(`PAX TCP bad STX: got 0x${buf[0].toString(16)}`);
  const lenHi = buf[1];
  const lenLo = buf[2];
  const dataLen = (lenHi << 8) | lenLo;
  const expectedTotal = 3 + dataLen + 2; // STX + LEN(2) + DATA + ETX + LRC
  if (buf.length < expectedTotal) {
    throw new Error(`PAX TCP frame truncated: have ${buf.length}, need ${expectedTotal}`);
  }
  const data = buf.slice(3, 3 + dataLen);
  const etx = buf[3 + dataLen];
  if (etx !== ETX) throw new Error(`PAX TCP bad ETX: got 0x${etx.toString(16)}`);
  const actualLrc = buf[3 + dataLen + 1];
  let expectedLrc = lenHi ^ lenLo ^ ETX;
  for (const b of data) expectedLrc ^= b;
  if ((expectedLrc & 0xff) !== actualLrc) {
    logger.warn(
      { expected: expectedLrc & 0xff, got: actualLrc },
      'pax tcp LRC mismatch (accepting payload anyway)',
    );
  }
  return data.toString('utf8');
}

/** Raw POSLink TCP transport.
 *  Single connection per request (no pool) — matches PAX firmware semantics
 *  where the device closes after each transaction. Buffers reads until we
 *  have a full frame, then resolves; rejects on timeout / socket error /
 *  malformed frame. */
async function sendPosLinkTcp(
  opts: PaxClientOptions,
  xml: string,
): Promise<PaxRawResponse> {
  const frame = buildPosLinkTcpFrame(xml);
  logger.info(
    { ip: opts.ip, port: opts.port, frameBytes: frame.length, timeoutMs: opts.timeoutMs },
    'pax tcp send',
  );

  return new Promise<PaxRawResponse>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    let expectedTotal = -1; // becomes known once we have STX + LEN

    const socket = net.createConnection({ host: opts.ip, port: opts.port });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`PAX TCP timeout after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    };

    const succeed = (raw: PaxRawResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.end();
      resolve(raw);
    };

    socket.on('connect', () => {
      socket.write(frame, (err) => {
        if (err) fail(err);
      });
    });

    socket.on('data', (chunk) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      // Compute expected total once STX + LEN(2) arrived.
      if (expectedTotal < 0 && buf.length >= 3) {
        if (buf[0] !== STX) {
          return fail(new Error(`PAX TCP bad STX: got 0x${buf[0].toString(16)}`));
        }
        const dataLen = (buf[1] << 8) | buf[2];
        expectedTotal = 3 + dataLen + 2;
      }
      if (expectedTotal > 0 && buf.length >= expectedTotal) {
        try {
          const xmlText = parsePosLinkTcpFrame(buf.slice(0, expectedTotal));
          logger.debug({ body: xmlText.substring(0, 1000) }, 'pax tcp response (raw)');
          succeed(parsePosLinkResponse(xmlText));
        } catch (err) {
          fail(err as Error);
        }
      }
    });

    socket.on('error', (err) => fail(err));
    socket.on('end', () => {
      if (!settled) fail(new Error('PAX TCP connection closed before full response'));
    });
  });
}

export { PAX_SUCCESS_CODE, escapeXml };
