/**
 * Minimal PAX terminal simulator for tests.
 *
 * Speaks the real POSLink Low Level Specification: an HTTP GET whose query
 * string is the base64-encoded request packet, answered with a framed response
 * packet. We have no PAX hardware in dev, so this stands in for it — and unlike
 * the previous XML/POST mock it exercises the actual codec.
 */
import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { AddressInfo } from 'net';
import {
  COMMAND,
  ETX,
  FS,
  PROTOCOL_VERSION,
  STX,
  SUCCESS_CODE,
  US,
  parsePacket,
} from '../src/poslink-protocol';

export interface PoslinkMockOptions {
  /** Replace the reply for a given command code (e.g. 'T00'). */
  override?: Partial<Record<string, Buffer>>;
  /** Delay before replying — used to exercise timeout handling. */
  delayMs?: number;
  /** Corrupt the trailing LRC so we can assert the client tolerates it. */
  breakLrc?: boolean;
}

export interface PoslinkMockHandle {
  url: string;
  port: number;
  /** Every request packet the mock decoded, in arrival order. */
  received: Array<{ command: string; fields: Array<string | string[]> }>;
  close(): Promise<void>;
}

/** Assemble a response packet from its top-level groups. */
export function buildMockResponse(groups: Array<string | string[]>, breakLrc = false): Buffer {
  const out: number[] = [STX];
  groups.forEach((group, index) => {
    if (index > 0) out.push(FS);
    const text = Array.isArray(group) ? group.join(String.fromCharCode(US)) : group;
    for (const byte of Buffer.from(text, 'ascii')) out.push(byte);
  });
  out.push(ETX);
  let lrc = 0;
  for (let i = 1; i < out.length; i++) lrc ^= out[i];
  out.push(breakLrc ? (lrc ^ 0xff) & 0xff : lrc & 0xff);
  return Buffer.from(out);
}

/**
 * Response shapes mirror PAX's sample: Status, Command, Version, ResponseCode,
 * ResponseMessage, then command-specific groups.
 */
function defaultResponse(command: string): Buffer {
  if (command === COMMAND.INITIALIZE) {
    return buildMockResponse([
      '0',
      COMMAND.INITIALIZE,
      PROTOCOL_VERSION,
      SUCCESS_CODE,
      'OK',
      'MOCKSN123456', // SN
      'A920', // ModelName
      '1.0.0', // OSVersion
      '00:11:22:33:44:55', // MacAddress
    ]);
  }

  if (command === COMMAND.DO_CREDIT) {
    return buildMockResponse([
      '0',
      COMMAND.DO_CREDIT,
      PROTOCOL_VERSION,
      SUCCESS_CODE,
      'APPROVED',
      // HostInformation: code, message, AuthCode, HostRefNum, TraceNum, BatchNum
      ['000', 'OK', 'TEST01', '998877', '5', '1'],
      '01', // TransactionType echo
      // AmountInformation: Approved, Due, Tip, CashBack, Fee, Tax, Bal1, Bal2
      ['4500', '', '500', '', '', '', '', ''],
      // AccountInformation: Account, EntryMode, ExpireDate, EBT, Voucher,
      // NewAccountNo, CardType, CardHolder, CVDApproval, CVDMessage, Present
      ['************4242', '1', '', '', '', '', 'VISA', '', '', '', '1'],
      // TraceInformation: TransactionNumber, ReferenceNumber, TimeStamp
      ['123', '1', '20260811090000'],
    ]);
  }

  return buildMockResponse(['0', command, PROTOCOL_VERSION, '100001', `Unknown command ${command}`]);
}

export async function startPoslinkMock(opts: PoslinkMockOptions = {}): Promise<PoslinkMockHandle> {
  const received: PoslinkMockHandle['received'] = [];

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'GET') {
      res.statusCode = 405;
      res.end();
      return;
    }

    const query = (req.url || '').split('?')[1] || '';
    let command = 'UNKNOWN';
    try {
      // The client sends raw base64; `+` and `/` are left unescaped, matching
      // PAX's sample, so decode the query string as-is.
      const parsed = parsePacket(Buffer.from(decodeURIComponent(query), 'base64'));
      command = typeof parsed.fields[0] === 'string' ? parsed.fields[0] : 'UNKNOWN';
      received.push({ command, fields: parsed.fields });
    } catch {
      res.statusCode = 400;
      res.end();
      return;
    }

    const respond = (): void => {
      const body = opts.override?.[command] ?? defaultResponse(command);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.end(
        opts.breakLrc && !opts.override?.[command]
          ? Buffer.concat([body.slice(0, -1), Buffer.from([body[body.length - 1] ^ 0xff])])
          : body,
      );
    };

    if (opts.delayMs && opts.delayMs > 0) setTimeout(respond, opts.delayMs);
    else respond();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        received,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
