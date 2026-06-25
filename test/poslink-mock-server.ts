/**
 * Minimal POSLink mock server for tests.
 * Speaks plaintext HTTP on a dynamically-allocated port; responds with canned
 * XML for SALE/VOID/RETURN/ADJUST/BATCHCLOSE/INIT. Use this in unit + integration
 * tests in lieu of a real PAX A920 (we don't have one in dev).
 */
import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { AddressInfo } from 'net';

export interface PoslinkMockOptions {
  /** Override response for a given TransType (returns full XML body). */
  override?: Partial<Record<string, string>>;
  /** Force a delay (ms) before responding — useful for timeout tests. */
  delayMs?: number;
}

const SUCCESS = '000000';

function defaultResponse(transType: string): string {
  switch (transType) {
    case 'SALE':
      return xml(SUCCESS, 'APPROVED', {
        RefNum: '000123',
        AuthCode: 'TEST01',
        CardType: 'VISA',
        LastFour: '4242',
        ApprovedAmount: '4500',
        ExtData: '<TipAmount>500</TipAmount>',
      });
    case 'VOID':
      return xml(SUCCESS, 'VOIDED', { RefNum: '000124' });
    case 'RETURN':
      return xml(SUCCESS, 'REFUNDED', {
        RefNum: '000125',
        ApprovedAmount: '4500',
      });
    case 'ADJUST':
      return xml(SUCCESS, 'ADJUSTED', { RefNum: '000123' });
    case 'BATCHCLOSE':
      return xml(SUCCESS, 'BATCH CLOSED', { RefNum: '000126' });
    case 'INIT':
      return xml(SUCCESS, 'OK', {});
    default:
      return xml('100001', `Unknown TransType ${transType}`, {});
  }
}

function xml(code: string, text: string, fields: Record<string, string>): string {
  const body = Object.entries(fields)
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join('');
  return `<RESPONSE><ResultCode>${code}</ResultCode><ResultTxt>${text}</ResultTxt>${body}</RESPONSE>`;
}

export interface PoslinkMockHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startPoslinkMock(opts: PoslinkMockOptions = {}): Promise<PoslinkMockHandle> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const transType = body.match(/<TransType>([^<]+)<\/TransType>/)?.[1] || 'UNKNOWN';
      const respond = (): void => {
        const out = opts.override?.[transType] ?? defaultResponse(transType);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/xml');
        res.end(out);
      };
      if (opts.delayMs && opts.delayMs > 0) setTimeout(respond, opts.delayMs);
      else respond();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}
