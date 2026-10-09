import { sendCommand } from '../pax-client';
import { getLogger } from '../logger';
import { BATCH_TRANS_TYPE, COMMAND, EDC_TYPE, subField } from '../poslink-protocol';
import type { DeviceEntry } from '../config';
import type { BatchClosePayload, CommandDiagnostics, PaxResult } from '../protocol/messages';

const logger = getLogger();

// Settlement talks to the processor, not just the terminal, so it is far
// slower than a sale. Backend allows 125s (TIMEOUT_BATCH_MS); stay under it.
const TIMEOUT_MS = 118_000;

/**
 * Batch close (B00) — settles the day's transactions with the processor.
 *
 * The packet layout is inferred, not documented: PAX's JavaScript sample stops
 * at DoCredit, and the Low Level Specification has not reached us. What we do
 * know is the envelope, which is identical for every POSLink command:
 *
 *   STX │ B00 │ FS │ Version │ FS │ TransType │ FS │ EDCType │ ETX │ LRC
 *
 * A wrong field layout produces a response with a non-zero ResponseCode rather
 * than a silent failure, so a single live run tells us whether this is right.
 * To make that one run count, every response field is logged — the layout of a
 * B00 reply (batch totals, host reference, counts) is otherwise unknown to us.
 *
 * The first two fields are assumed to follow DoCredit: ResponseCode at index 3
 * and ResponseMessage at index 4, after Status/Command/Version.
 */
const RSP_CODE = 3;
const RSP_MESSAGE = 4;

export async function handleBatchClose(
  device: DeviceEntry,
  _payload: BatchClosePayload,
  diagnostics?: Partial<CommandDiagnostics>,
): Promise<PaxResult> {
  const parsed = await sendCommand(
    { ip: device.ip, port: device.port, timeoutMs: TIMEOUT_MS, diagnostics },
    COMMAND.BATCH_CLOSE,
    [BATCH_TRANS_TYPE.CLOSE, EDC_TYPE.ALL],
  );

  const resultCode = subField(parsed, RSP_CODE, 0);
  const resultText = subField(parsed, RSP_MESSAGE, 0);

  // Discovery aid: dump the whole reply so the first real settlement teaches us
  // the field layout. Batch replies carry no PAN, so this is safe to log.
  logger.info(
    { resultCode, resultText, fields: parsed.fields, lrcValid: parsed.lrcValid },
    'batch close raw response',
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
    // Keep the untyped tail around so the backend's closeout record holds
    // whatever totals the terminal reported, even before we can name them.
    raw_response: {
      resultCode,
      resultText,
      fields: JSON.stringify(parsed.fields),
    },
  };
}
