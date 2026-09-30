import { sendCommand } from '../pax-client';
import { getLogger } from '../logger';
import { COMMAND, SUCCESS_CODE, subField } from '../poslink-protocol';
import type { DeviceEntry } from '../config';
import type { PaxResult, SalePayload } from '../protocol/messages';

const logger = getLogger();

/**
 * Print a customer receipt on the terminal's own printer (A60).
 *
 * Packet per PAX's JavaScript sample (`management.js`, PRINTER()):
 *   STX │ A60 │ FS │ Version │ FS │ (empty) │ FS │ PrintData │ ETX │ LRC
 * PrintData markup: \C centre, \L left, \R right (rest of line), \1..\3 font
 * size, \n newline.
 *
 * Never throws: a paper jam must not turn an approved charge into a failure.
 */
export async function printReceipt(
  device: DeviceEntry,
  payload: SalePayload,
  result: PaxResult,
  timeoutMs: number,
  now: Date = new Date(),
): Promise<{ receipt_printed: boolean; receipt_error?: string }> {
  try {
    const parsed = await sendCommand(
      { ip: device.ip, port: device.port, timeoutMs },
      COMMAND.PRINT,
      ['', buildReceipt(payload, result, now)],
    );
    const code = subField(parsed, 3, 0);
    if (code === SUCCESS_CODE) return { receipt_printed: true };
    // e.g. 100032 OUT OF PAPER
    const error = `${code || 'NO_RESPONSE_CODE'} ${subField(parsed, 4, 0)}`.trim();
    logger.warn({ error }, 'receipt not printed');
    return { receipt_printed: false, receipt_error: error };
  } catch (err) {
    const error = (err as Error).message || 'print failed';
    logger.warn({ error }, 'receipt not printed');
    return { receipt_printed: false, receipt_error: error };
  }
}

export function buildReceipt(payload: SalePayload, result: PaxResult, now: Date): string {
  const amount = payload.amount_cents;
  const tip = result.tip_amount_cents;
  const card = [result.card_brand || result.card_type, result.last_four && `****${result.last_four}`]
    .filter(Boolean)
    .join(' ');
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}`;

  const lines: string[] = [];
  const salon = clean(payload.receipt?.salon_name ?? '');
  if (salon) lines.push(`\\C\\2${salon}`);
  for (const extra of payload.receipt?.lines ?? []) {
    const text = clean(extra);
    if (text) lines.push(`\\C\\1${text}`);
  }
  lines.push(`\\C\\1${stamp}`, '', '\\C\\3SALE');
  if (card) lines.push(`\\L\\1Card\\R\\1${clean(card)}`);
  if (result.auth_code) lines.push(`\\L\\1Auth code\\R\\1${clean(result.auth_code)}`);
  lines.push(
    `\\L\\1Amount\\R\\1${money(amount)}`,
    `\\L\\1Tip\\R\\1${money(tip)}`,
    `\\L\\2Total\\R\\2${money(amount + tip)}`,
    '',
    '\\C\\2APPROVED',
    '\\C\\1Customer copy',
  );
  return lines.join('\\n') + '\\n';
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * The packet is ASCII and framed by control bytes, and `\` starts a print
 * command. Salon names are often Vietnamese, so strip accents rather than drop
 * the letters, then drop anything that could break the frame or the markup.
 */
function clean(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, (c) => (c === 'đ' ? 'd' : 'D'))
    .replace(/[^\x20-\x7e]|\\/g, '')
    .trim()
    .slice(0, 40);
}
