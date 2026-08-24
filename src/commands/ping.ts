import { sendCommand } from '../pax-client';
import { COMMAND, SUCCESS_CODE, subField } from '../poslink-protocol';
import type { DeviceEntry } from '../config';
import type { PaxResult } from '../protocol/messages';

// Backend governs the overall ping budget at 5s (TIMEOUT_PING_MS in
// pax-adapter.service.ts). This is a safety net sized so we don't abort while
// the terminal is waking from sleep or switching Wi-Fi.
const TIMEOUT_MS = 9_000;

/**
 * Initialize (A00) — asks the terminal to identify itself. It touches no card
 * and starts no transaction, so it is safe to call as a liveness probe.
 *
 * The response layout differs from DoCredit: Status, Command, Version,
 * ResponseCode, ResponseMessage, SN, ModelName, OSVersion, MacAddress, …
 */
const INIT_RESPONSE_CODE = 3;
const INIT_RESPONSE_MESSAGE = 4;
const INIT_SERIAL_NUMBER = 5;
const INIT_MODEL_NAME = 6;

export async function handlePing(device: DeviceEntry): Promise<PaxResult> {
  const parsed = await sendCommand(
    { ip: device.ip, port: device.port, timeoutMs: TIMEOUT_MS },
    COMMAND.INITIALIZE,
  );

  const resultCode = subField(parsed, INIT_RESPONSE_CODE, 0);
  const resultText = subField(parsed, INIT_RESPONSE_MESSAGE, 0);

  return {
    result_code: resultCode || SUCCESS_CODE,
    result_text: resultText,
    ref_num: '',
    auth_code: '',
    card_type: '',
    last_four: '',
    approved_amount_cents: 0,
    tip_amount_cents: 0,
    // Serial and model make it obvious in the logs which terminal answered.
    raw_response: {
      resultCode,
      resultText,
      serialNumber: subField(parsed, INIT_SERIAL_NUMBER, 0),
      modelName: subField(parsed, INIT_MODEL_NAME, 0),
    },
  };
}
