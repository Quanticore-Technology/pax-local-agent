/**
 * Wire protocol shared between the cloud backend gateway and the on-prem agent.
 *
 * Transport: JSON text frames over a single persistent WebSocket (TLS, port 443).
 * All messages have a `type`; request/response pairs are matched via `id`.
 *
 * Copy this file verbatim into the agent repo to keep types in sync.
 */

export const PROTOCOL_VERSION = 1;

export type PaxCommand =
  | 'pax.sale'
  | 'pax.void'
  | 'pax.refund'
  | 'pax.tip_adjust'
  | 'pax.batch_close'
  | 'pax.ping'
  | 'pax.cancel'
  | 'config.set_devices';

export interface SalePayload {
  device_id: string;
  amount_cents: number;
  /** device_payments.external_payment_id — the agent's idempotency key for sales. */
  external_id: string;
  /** Print a customer receipt on the terminal after an APPROVED sale. */
  print_receipt?: boolean;
  /** Optional header info for that receipt. */
  receipt?: { salon_name?: string; lines?: string[] };
}

export interface VoidPayload {
  device_id: string;
  orig_ref_num: string;
  reason?: string;
}

export interface RefundPayload {
  device_id: string;
  orig_ref_num?: string;
  amount_cents: number;
  reason?: string;
}

export interface TipAdjustPayload {
  device_id: string;
  orig_ref_num: string;
  tip_cents: number;
}

export interface BatchClosePayload {
  device_id: string;
}

export interface PingPayload {
  device_id?: string;
}

export interface CancelPayload {
  device_id: string;
}

/** Terminal address as configured on the agent. */
export interface DeviceAddress {
  device_id: string;
  ip: string;
  port: number;
}

/** API → agent: replace the terminal addresses in the agent's config. */
export interface SetDevicesPayload {
  devices: DeviceAddress[];
}

/** Success result of `config.set_devices`: the devices as saved. */
export interface SetDevicesResult {
  devices: DeviceAddress[];
}

export type CommandPayload =
  | SalePayload
  | VoidPayload
  | RefundPayload
  | TipAdjustPayload
  | BatchClosePayload
  | PingPayload
  | CancelPayload
  | SetDevicesPayload;

/** Sanitized fields the agent extracts from POSLink responses (no PAN/CVV). */
export interface PaxResult {
  result_code: string;
  result_text: string;
  ref_num: string;
  auth_code: string;
  card_type: string;
  last_four: string;
  approved_amount_cents: number;
  tip_amount_cents: number;
  raw_response: Record<string, string>;
  /** Human card brand mapped from the POSLink card type code (01 Visa, 02 Mastercard, …). */
  card_brand?: string;
  /** Whitelisted chip fields (AID, APPLAB, TC, TVR, TSI, …). Never the full PAN. */
  emv?: Record<string, string>;
  /** Set when print_receipt was asked for. */
  receipt_printed?: boolean;
  receipt_error?: string;
}

export interface RequestMessage {
  type: 'request';
  id: string;
  command: PaxCommand;
  payload: CommandPayload;
}

export interface ResponseSuccess {
  type: 'response';
  id: string;
  success: true;
  result: PaxResult | SetDevicesResult;
}

export interface ResponseError {
  type: 'response';
  id: string;
  success: false;
  error: { code: string; message: string };
}

export type ResponseMessage = ResponseSuccess | ResponseError;

/** Agent → server, sent immediately after WS open. */
export interface HelloMessage {
  type: 'hello';
  agent_id: string;
  version: string;
  protocol_version: number;
  devices: Array<{ device_id: string; ip: string; port: number }>;
}

/** Agent → server, structured log shipping (rate-limited on the agent side). */
export interface LogMessage {
  type: 'log';
  level: 'info' | 'warn' | 'error';
  message: string;
  ts: number;
  context?: Record<string, unknown>;
}

/** Agent → server: reachability of each configured terminal. */
export interface TerminalStatusMessage {
  type: 'terminal_status';
  devices: Array<{
    device_id: string;
    ip: string;
    port: number;
    reachable: boolean;
    serial?: string;
    model?: string;
    /** ISO timestamp of the last check. */
    checked_at: string;
    /** True when the agent found the terminal at a new IP by itself. */
    discovered?: boolean;
  }>;
}

/** Agent → server: a journaled pax.sale result, re-sent after (re)connect until acknowledged. */
export interface SaleResultReplayMessage {
  type: 'sale_result_replay';
  external_id: string;
  request_id: string;
  result: PaxResult;
  /** ISO timestamp. */
  completed_at: string;
}

/** Server → agent: the replayed sale result was applied; the agent may drop it. */
export interface ReplayAckMessage {
  type: 'replay_ack';
  external_id: string;
}

/** Bi-directional liveness frame outside of native WS ping/pong. */
export interface HeartbeatMessage {
  type: 'heartbeat';
  ts: number;
}

export type AgentMessage =
  | HelloMessage
  | LogMessage
  | HeartbeatMessage
  | ResponseMessage
  | TerminalStatusMessage
  | SaleResultReplayMessage;
export type ServerMessage = RequestMessage | HeartbeatMessage | ReplayAckMessage;

/** Stable error codes returned to the cloud caller. */
export const ERROR_CODES = {
  AGENT_OFFLINE: 'AGENT_OFFLINE',
  AGENT_TIMEOUT: 'AGENT_TIMEOUT',
  DEVICE_UNREACHABLE: 'DEVICE_UNREACHABLE',
  DEVICE_BUSY: 'DEVICE_BUSY',
  INVALID_DEVICE_ID: 'INVALID_DEVICE_ID',
  POSLINK_ERROR: 'POSLINK_ERROR',
  PROTOCOL_ERROR: 'PROTOCOL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
