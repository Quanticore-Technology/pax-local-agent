/**
 * Talks to a PAX A920 on the salon LAN using the POSLink Low Level
 * Specification (see `poslink-protocol.ts` for the packet format).
 *
 * Transport is HTTP GET with the base64-encoded packet as the query string —
 * the method PAX support confirmed for POS platforms without an official SDK,
 * and the one their JavaScript sample uses:
 *
 *   GET http://<ip>:<port>?<base64 packet>
 *
 * The terminal must have ECR Comm Settings → Comm Type = Ethernet and
 * Protocol Type = "HTTP GET" for this to work.
 *
 * We use `http.request` with an explicitly built path rather than `fetch`, so
 * the base64 payload reaches the terminal byte-for-byte: it contains `+`, `/`
 * and `=`, and PAX's sample sends them unescaped.
 */
import http from 'http';
import { getLogger } from './logger';
import type { PaxResult } from './protocol/messages';
import {
  PacketGroup,
  ParsedResponse,
  SUCCESS_CODE,
  buildPacket,
  encodePacket,
  parsePacket,
  subField,
} from './poslink-protocol';

const logger = getLogger();

/**
 * Field positions in a DoCredit (T00) response, derived from PAX's JavaScript
 * sample. Top-level index first, sub-field position second.
 */
const RSP = {
  RESPONSE_CODE: 3,
  RESPONSE_MESSAGE: 4,
  HOST_INFO: 5,
  AMOUNT_INFO: 7,
  ACCOUNT_INFO: 8,
  TRACE_INFO: 9,
} as const;

const HOST_AUTH_CODE = 2;
const HOST_REFERENCE_NUMBER = 3;

const AMOUNT_APPROVED = 0;
const AMOUNT_TIP = 2;

const ACCOUNT_MASKED_PAN = 0;
const ACCOUNT_CARD_TYPE = 6;

const TRACE_TRANSACTION_NUMBER = 0;
const TRACE_REFERENCE_NUMBER = 1;

export interface PaxClientOptions {
  ip: string;
  port: number;
  /** Request timeout (ms). */
  timeoutMs: number;
}

/**
 * Send one command to the terminal and return the parsed response.
 * Rejects on timeout, socket error, or a structurally broken reply.
 */
export async function sendCommand(
  opts: PaxClientOptions,
  command: string,
  groups: PacketGroup[] = [],
): Promise<ParsedResponse> {
  const packet = buildPacket(command, groups);
  const query = encodePacket(packet);

  logger.info(
    { ip: opts.ip, port: opts.port, command, packetBytes: packet.length, timeoutMs: opts.timeoutMs },
    'poslink request',
  );

  const raw = await httpGet(opts, query);
  const parsed = parsePacket(raw);

  if (!parsed.lrcValid) {
    // Tolerated: some firmware builds compute the LRC slightly differently and
    // the payload is still correct. Logged so we notice if it becomes routine.
    logger.warn({ command }, 'poslink response LRC mismatch (accepting payload)');
  }
  logger.info(
    { command, code: subFieldSafe(parsed, RSP.RESPONSE_CODE), fields: parsed.fields.length },
    'poslink response',
  );
  return parsed;
}

/** Issue the GET and collect the raw response bytes. */
function httpGet(opts: PaxClientOptions, query: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;

    const request = http.request(
      {
        host: opts.ip,
        port: opts.port,
        method: 'GET',
        // The query string is the base64 packet, passed through untouched.
        path: `/?${query}`,
        timeout: opts.timeoutMs,
      },
      (response) => {
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          if (settled) return;
          settled = true;
          resolve(Buffer.concat(chunks));
        });
      },
    );

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(err);
    };

    request.on('timeout', () => fail(new Error(`PAX request timed out after ${opts.timeoutMs}ms`)));
    request.on('error', fail);
    request.end();
  });
}

function subFieldSafe(parsed: ParsedResponse, index: number): string {
  return subField(parsed, index, 0);
}

/** Last four digits of a masked PAN such as `************4242`. */
function lastFourOf(maskedPan: string): string {
  const digits = maskedPan.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : '';
}

function toCents(value: string): number {
  const parsed = parseInt(value || '0', 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Map a parsed DoCredit response onto the wire-protocol shape the cloud expects.
 *
 * `baseAmountCents` is the amount we requested; it lets us derive the tip when
 * the terminal reports only an approved total.
 */
export function toPaxResult(parsed: ParsedResponse, baseAmountCents: number): PaxResult {
  const resultCode = subField(parsed, RSP.RESPONSE_CODE, 0);
  const resultText = subField(parsed, RSP.RESPONSE_MESSAGE, 0);

  const approvedCents = toCents(subField(parsed, RSP.AMOUNT_INFO, AMOUNT_APPROVED));
  const reportedTipCents = toCents(subField(parsed, RSP.AMOUNT_INFO, AMOUNT_TIP));

  // Prefer the terminal's own tip figure; fall back to the difference when it
  // reports only a total (tip entered on-screen but not itemised).
  let tipCents = reportedTipCents;
  if (!tipCents && approvedCents > baseAmountCents) {
    tipCents = approvedCents - baseAmountCents;
  }

  // TransactionNumber is what VOID and ADJUST reference later, so that is what
  // we surface as ref_num.
  const transactionNumber = subField(parsed, RSP.TRACE_INFO, TRACE_TRANSACTION_NUMBER);
  const referenceNumber = subField(parsed, RSP.TRACE_INFO, TRACE_REFERENCE_NUMBER);
  const authCode = subField(parsed, RSP.HOST_INFO, HOST_AUTH_CODE);
  const hostReferenceNumber = subField(parsed, RSP.HOST_INFO, HOST_REFERENCE_NUMBER);
  const cardType = subField(parsed, RSP.ACCOUNT_INFO, ACCOUNT_CARD_TYPE);
  const lastFour = lastFourOf(subField(parsed, RSP.ACCOUNT_INFO, ACCOUNT_MASKED_PAN));

  return {
    result_code: resultCode,
    result_text: resultText,
    ref_num: transactionNumber,
    auth_code: authCode,
    card_type: cardType,
    last_four: lastFour,
    approved_amount_cents: approvedCents,
    tip_amount_cents: tipCents > 0 ? tipCents : 0,
    // PCI: only these normalised fields are forwarded. The masked PAN, entry
    // mode, cardholder name and any EMV data stay on this machine.
    raw_response: {
      resultCode,
      resultText,
      transactionNumber,
      referenceNumber,
      hostReferenceNumber,
      authCode,
      cardType,
      lastFour,
      approvedAmount: String(approvedCents),
    },
  };
}

export { SUCCESS_CODE as PAX_SUCCESS_CODE };
