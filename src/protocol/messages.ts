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
  /** Not a terminal command: rewrites the agent's terminal addresses. Old agents answer PROTOCOL_ERROR. */
  | 'config.set_devices';

export interface SalePayload {
  device_id: string;
  amount_cents: number;
  external_id: string;
  /** Print a customer receipt on the terminal after an APPROVED sale. Absent = don't print (old API). */
  print_receipt?: boolean;
  /** Optional header for that receipt. */
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
  closeout_id?: string;
}

export interface PingPayload {
  device_id?: string;
}

export interface CancelPayload {
  device_id: string;
  /** Only abort if this sale is the one on the terminal; otherwise the agent answers result_code NOT_RUNNING. */
  external_id?: string;
}

/** One terminal address on the salon LAN. */
export interface DeviceAddress {
  device_id: string;
  ip: string;
  port: number;
}

export interface SetDevicesPayload {
  devices: DeviceAddress[];
}

/** Success result of `config.set_devices`: the devices as the agent saved them. */
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
  /** Human card brand from the POSLink card type code (01 Visa … 07 JCB); undefined when unknown. */
  card_brand?: string;
  /** Whitelisted chip fields (AID, app label, TC, TVR, TSI, entry mode). Never the full PAN. */
  emv?: Record<string, string>;
  /** Set only when print_receipt was asked for. */
  receipt_printed?: boolean;
  receipt_error?: string;
}

/** What a successful response carries: PaxResult for pax.* commands, SetDevicesResult for config.set_devices. */
export type CommandResult = PaxResult | SetDevicesResult;

export interface RequestMessage {
  type: 'request';
  id: string;
  command: PaxCommand;
  payload: CommandPayload;
}

export interface CommandDiagnostics {
  elapsed_ms: number;
  connect_ms?: number;
  response_ms?: number;
  transport_code?: string;
  request_sent?: boolean;
}

export interface ResponseSuccess {
  diagnostics?: CommandDiagnostics;
  type: 'response';
  id: string;
  success: true;
  result: CommandResult;
}

export interface ResponseError {
  diagnostics?: CommandDiagnostics;
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
  devices: DeviceAddress[];
}

/** Agent → server, structured log shipping (rate-limited on the agent side). */
export interface LogMessage {
  type: 'log';
  level: 'info' | 'warn' | 'error';
  message: string;
  ts: number;
  context?: Record<string, unknown>;
}

/** Bi-directional liveness frame outside of native WS ping/pong. */
export interface HeartbeatMessage {
  type: 'heartbeat';
  ts: number;
}

/** What the agent last saw of one terminal. */
export interface TerminalStatus extends DeviceAddress {
  diagnostics?: CommandDiagnostics;
  reachable: boolean;
  serial?: string;
  model?: string;
  /** ISO timestamp of the check. */
  checked_at: string;
  /** True when the agent found the terminal at a new IP by itself. */
  discovered?: boolean;
}

/** Agent → server: sent after hello, on any reachability/address change, and at least every 60 s. */
export interface TerminalStatusMessage {
  type: 'terminal_status';
  devices: TerminalStatus[];
}

/**
 * Agent → server: a finished pax.sale result the server may never have received
 * (journaled before sending). Re-sent after every (re)connect until acked.
 */
export interface SaleResultReplayMessage {
  type: 'sale_result_replay';
  external_id: string;
  request_id: string;
  result: PaxResult;
  /** ISO timestamp. */
  completed_at: string;
}

/** Server → agent: always sent for a sale_result_replay; the agent drops the journal entry. */
export interface ReplayAckMessage {
  type: 'replay_ack';
  external_id: string;
}

export interface BatchResultReplayMessage {
  type: 'batch_result_replay';
  closeout_id: string;
  request_id: string;
  device_id: string;
  response: ResponseMessage;
  completed_at: string;
}

export interface BatchReplayAckMessage {
  type: 'batch_replay_ack';
  closeout_id: string;
  request_id: string;
}

export type AgentMessage =
  | HelloMessage
  | LogMessage
  | HeartbeatMessage
  | ResponseMessage
  | TerminalStatusMessage
  | SaleResultReplayMessage
  | BatchResultReplayMessage;
export type ServerMessage = RequestMessage | HeartbeatMessage | ReplayAckMessage | BatchReplayAckMessage;

/** Stable error codes returned to the cloud caller. */
export const ERROR_CODES = {
  AGENT_OFFLINE: 'AGENT_OFFLINE',
  AGENT_TIMEOUT: 'AGENT_TIMEOUT',
  DEVICE_UNREACHABLE: 'DEVICE_UNREACHABLE',
  TERMINAL_NO_RESPONSE: 'TERMINAL_NO_RESPONSE',
  DEVICE_BUSY: 'DEVICE_BUSY',
  INVALID_DEVICE_ID: 'INVALID_DEVICE_ID',
  POSLINK_ERROR: 'POSLINK_ERROR',
  PROTOCOL_ERROR: 'PROTOCOL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
