/* Helper: start POSLink mock on a fixed port for smoke tests. */
import { startPoslinkMock } from './poslink-mock-server';
import { createServer } from 'http';

const PORT = 10009;

(async () => {
  // We can't pass port to startPoslinkMock (ephemeral by design), so wrap a tiny
  // listener that proxies the same handler logic by calling the mock helper and
  // re-binding. Simpler: just listen on PORT directly with the mock's logic.
  const handler = await import('./poslink-mock-server');
  // The mock helper returns a server bound to ephemeral 0; for fixed-port use,
  // re-implement minimal version inline below.
  void handler;

  const server = createServer((req, res) => {
    if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const transType = body.match(/<TransType>([^<]+)<\/TransType>/)?.[1] || 'UNKNOWN';
      const success = '000000';
      // Echo request <Amount> back so partial refunds work correctly. For
      // SALE we also inject a tip if MOCK_TIP_PCT is set.
      const reqAmount = parseInt(body.match(/<Amount>([^<]+)<\/Amount>/)?.[1] || '0', 10) || 0;
      const tipPct = parseFloat(process.env.MOCK_TIP_PCT || '0');
      const tipCents = Math.round(reqAmount * (tipPct / 100));
      const saleApprovedCents = reqAmount + tipCents;
      const xml = (() => {
        switch (transType) {
          case 'SALE':
            // Echo base + tip so the adapter sees a realistic transaction.
            return `<RESPONSE><ResultCode>${success}</ResultCode><ResultTxt>APPROVED</ResultTxt><RefNum>000123</RefNum><AuthCode>TEST01</AuthCode><CardType>VISA</CardType><LastFour>4242</LastFour><ApprovedAmount>${saleApprovedCents}</ApprovedAmount><ExtData><TipAmount>${tipCents}</TipAmount></ExtData></RESPONSE>`;
          case 'VOID':
            return `<RESPONSE><ResultCode>${success}</ResultCode><ResultTxt>VOIDED</ResultTxt><RefNum>000124</RefNum></RESPONSE>`;
          case 'RETURN':
            // Echo the requested refund amount so partial refunds work.
            return `<RESPONSE><ResultCode>${success}</ResultCode><ResultTxt>REFUNDED</ResultTxt><RefNum>000125</RefNum><ApprovedAmount>${reqAmount}</ApprovedAmount></RESPONSE>`;
          case 'ADJUST':
            return `<RESPONSE><ResultCode>${success}</ResultCode><ResultTxt>ADJUSTED</ResultTxt><RefNum>000123</RefNum></RESPONSE>`;
          case 'BATCHCLOSE':
            return `<RESPONSE><ResultCode>${success}</ResultCode><ResultTxt>BATCH CLOSED</ResultTxt><RefNum>000126</RefNum></RESPONSE>`;
          case 'INIT':
            return `<RESPONSE><ResultCode>${success}</ResultCode><ResultTxt>OK</ResultTxt></RESPONSE>`;
          default:
            return `<RESPONSE><ResultCode>100001</ResultCode><ResultTxt>Unknown ${transType}</ResultTxt></RESPONSE>`;
        }
      })();
      console.log(`[mock] ${transType} amount=${reqAmount} -> ${xml.substring(0, 80)}...`);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/xml');
      res.end(xml);
    });
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`MOCK_LISTENING port=${PORT}`);
  });
})();
