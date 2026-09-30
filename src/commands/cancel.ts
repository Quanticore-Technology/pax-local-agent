import { sendCommand } from '../pax-client';
import { getLogger } from '../logger';
import { COMMAND, subField } from '../poslink-protocol';
import { DEFAULT_SECONDARY_PORT } from '../config';
import type { DeviceEntry } from '../config';
import type { PaxResult } from '../protocol/messages';

const logger = getLogger();

// An abort must beat the sale it is cancelling, and the caller is a person
// staring at a screen. Fail fast rather than hanging the checkout UI.
const TIMEOUT_MS = 8_000;

/** Response layout is assumed to match every other command: code at 3, text at 4. */
const RSP_CODE = 3;
const RSP_MESSAGE = 4;

/**
 * Cancel an in-progress sale on the terminal.
 *
 * Two things make this different from every other command we send:
 *
 * 1. It goes to the terminal's SECONDARY port, not the primary one. A sale
 *    holds the primary listener for as long as it waits for a card — up to
 *    175s — so an abort sent there would queue behind the sale instead of
 *    interrupting it.
 *
 * 2. The command code is a guess. PAX's JavaScript sample covers only
 *    A00/A08/A20/T00, and the setup guide we hold documents no abort. Every
 *    response field is logged so a single live attempt tells us whether A16 is
 *    right, and if not, what the terminal says instead.
 *
 * Failure is reported, never thrown: the backend treats cancel as best-effort
 * and marks the payment Failed regardless, so staff are never stuck. If this
 * does not reach the terminal, the customer presses Cancel on the device and
 * the in-flight sale returns a user-cancelled result on its own.
 */
export async function handleCancel(device: DeviceEntry): Promise<PaxResult> {
  const port = device.secondary_port ?? DEFAULT_SECONDARY_PORT;

  try {
    const parsed = await sendCommand(
      { ip: device.ip, port, timeoutMs: TIMEOUT_MS },
      COMMAND.ABORT,
    );

    const resultCode = subField(parsed, RSP_CODE, 0);
    const resultText = subField(parsed, RSP_MESSAGE, 0);

    logger.info(
      { port, resultCode, resultText, fields: parsed.fields },
      'cancel raw response',
    );

    return {
      // A reply without a response code is not a success.
      result_code: resultCode || 'NO_RESPONSE_CODE',
      result_text: resultText,
      ref_num: '',
      auth_code: '',
      card_type: '',
      last_four: '',
      approved_amount_cents: 0,
      tip_amount_cents: 0,
      raw_response: { resultCode, resultText, fields: JSON.stringify(parsed.fields) },
    };
  } catch (err) {
    // Most likely causes: the secondary listener is disabled in ECR Comm
    // Settings, or A16 is not the abort code. Both are worth seeing in the log,
    // neither should break the checkout flow.
    const message = (err as Error).message || 'cancel failed';
    logger.warn({ port, message }, 'cancel did not reach the terminal');

    return {
      result_code: 'CANCEL_FAILED',
      result_text: message,
      ref_num: '',
      auth_code: '',
      card_type: '',
      last_four: '',
      approved_amount_cents: 0,
      tip_amount_cents: 0,
      raw_response: { error: message, port: String(port) },
    };
  }
}
