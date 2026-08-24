/**
 * Locks the POSLink Low Level packet format down to the byte.
 *
 * The reference vector comes from PAX's own JavaScript sample: an Initialize
 * (A00) request at protocol version 1.28. If these bytes ever change, the agent
 * has stopped speaking the terminal's language — which is exactly the failure
 * that went undetected for months when this layer had no tests.
 */
import {
  COMMAND,
  ETX,
  FS,
  PROTOCOL_VERSION,
  STX,
  TRANS_TYPE,
  US,
  buildPacket,
  buildQuery,
  parsePacket,
  subField,
} from '../src/poslink-protocol';
import { buildCreditGroups, toInvoiceNumber } from '../src/poslink-credit-request';
import { toPaxResult } from '../src/pax-client';
import { buildMockResponse } from './poslink-mock-server';

const hex = (buf: Buffer): string => [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ');

describe('poslink packet builder', () => {
  it('encodes Initialize exactly as PAX’s JavaScript sample does', () => {
    const packet = buildPacket(COMMAND.INITIALIZE);
    expect(hex(packet)).toBe('02 41 30 30 1c 31 2e 32 38 03 4b');
    expect(buildQuery(COMMAND.INITIALIZE)).toBe('AkEwMBwxLjI4A0s=');
  });

  it('frames every packet as STX … ETX + LRC over everything after STX', () => {
    const packet = buildPacket(COMMAND.DO_CREDIT, [TRANS_TYPE.SALE]);
    expect(packet[0]).toBe(STX);

    const etxIndex = packet.indexOf(ETX);
    expect(etxIndex).toBeGreaterThan(0);
    expect(packet.length).toBe(etxIndex + 2); // ETX then one LRC byte

    let expectedLrc = 0;
    for (let i = 1; i <= etxIndex; i++) expectedLrc ^= packet[i];
    expect(packet[packet.length - 1]).toBe(expectedLrc);
  });

  it('separates groups with FS and fields within a group with US', () => {
    const packet = buildPacket(COMMAND.DO_CREDIT, [TRANS_TYPE.SALE, ['100', '50']]);
    const body = packet.slice(1, packet.indexOf(ETX)).toString('ascii');
    expect(body).toBe(
      ['T00', PROTOCOL_VERSION, '01', `100${String.fromCharCode(US)}50`].join(
        String.fromCharCode(FS),
      ),
    );
  });

  it('keeps positions when a field is blank but omits a wholly empty group', () => {
    const withHole = buildPacket('T00', [['', 'x']]).toString('ascii');
    expect(withHole).toContain(`${String.fromCharCode(US)}x`);

    // An entirely empty group collapses, leaving two adjacent separators.
    const allEmpty = buildPacket('T00', [['', ''], 'tail']);
    const separators = String.fromCharCode(FS) + String.fromCharCode(FS);
    expect(allEmpty.toString('ascii')).toContain(separators);
  });
});

describe('poslink response parser', () => {
  const response = buildMockResponse([
    '0',
    'T00',
    PROTOCOL_VERSION,
    '000000',
    'APPROVED',
    ['000', 'OK', 'AUTH99'],
  ]);

  it('splits top-level groups and US sub-fields', () => {
    const parsed = parsePacket(response);
    expect(parsed.fields[0]).toBe('0');
    expect(parsed.fields[1]).toBe('T00');
    expect(parsed.fields[3]).toBe('000000');
    expect(parsed.fields[5]).toEqual(['000', 'OK', 'AUTH99']);
    expect(subField(parsed, 5, 2)).toBe('AUTH99');
  });

  it('reports a bad LRC without discarding a readable payload', () => {
    const corrupted = Buffer.concat([
      response.slice(0, -1),
      Buffer.from([response[response.length - 1] ^ 0xff]),
    ]);
    const parsed = parsePacket(corrupted);
    expect(parsed.lrcValid).toBe(false);
    expect(parsed.fields[3]).toBe('000000');
  });

  it('rejects structurally broken packets', () => {
    expect(() => parsePacket(Buffer.from([0x41, 0x42, 0x43]))).toThrow(/STX/);
    expect(() => parsePacket(Buffer.from([STX, 0x41, 0x42]))).toThrow(/ETX/);
    expect(() => parsePacket(Buffer.alloc(0))).toThrow(/too short/);
  });

  it('returns empty strings for fields the terminal omitted', () => {
    const parsed = parsePacket(buildMockResponse(['0', 'T00']));
    expect(subField(parsed, 9, 0)).toBe('');
    expect(subField(parsed, 5, 3)).toBe('');
  });
});

describe('DoCredit request groups', () => {
  it('emits nine positional groups', () => {
    expect(buildCreditGroups({ transactionType: TRANS_TYPE.SALE })).toHaveLength(9);
  });

  it('places amount, invoice and original transaction number correctly', () => {
    const groups = buildCreditGroups({
      transactionType: TRANS_TYPE.SALE,
      amountCents: 4500,
      invoiceNumber: '000000000042',
      origTransactionNumber: '123',
    });
    const amount = groups[1] as string[];
    const trace = groups[3] as string[];

    expect(amount[0]).toBe('4500');
    expect(trace[1]).toBe('000000000042');
    expect(trace[3]).toBe('123');
  });

  // Regression: sending the raw UUID here made the terminal answer
  // "INVOICE INVALID" and refuse the sale before reading a card.
  it('folds a UUID external id into a 12-digit invoice number', () => {
    const groups = buildCreditGroups({
      transactionType: TRANS_TYPE.SALE,
      amountCents: 102,
      invoiceNumber: '3f2a9c1e-7b4d-4e8a-9f21-6c5d8e0a1b23',
    });
    expect((groups[3] as string[])[1]).toMatch(/^\d{12}$/);
  });

  describe('toInvoiceNumber', () => {
    it('passes through an id that is already a legal invoice number', () => {
      expect(toInvoiceNumber('42')).toBe('42');
      expect(toInvoiceNumber('000000000123')).toBe('000000000123');
    });

    it('always yields at most 12 digits, whatever the input', () => {
      for (const id of [
        '3f2a9c1e-7b4d-4e8a-9f21-6c5d8e0a1b23',
        'ffffffff-ffff-ffff-ffff-ffffffffffff',
        'pay_ABC-999',
        '1234567890123456789',
      ]) {
        expect(toInvoiceNumber(id)).toMatch(/^\d{1,12}$/);
      }
    });

    it('is deterministic, so a PAX report row maps back to the payment', () => {
      const id = '3f2a9c1e-7b4d-4e8a-9f21-6c5d8e0a1b23';
      expect(toInvoiceNumber(id)).toBe(toInvoiceNumber(id));
    });

    it('sends no invoice when the id has nothing numeric in it', () => {
      expect(toInvoiceNumber('zzz')).toBe('');
    });
  });

  describe('additionalInformation', () => {
    it('asks the terminal to prompt for a tip when tipPrompt is set', () => {
      const groups = buildCreditGroups({
        transactionType: TRANS_TYPE.SALE,
        amountCents: 102,
        tipPrompt: true,
      });
      expect(groups[8]).toEqual(['TIPREQ=1']);
    });

    it('stays empty otherwise, so VOID and ADJUST never prompt for a tip', () => {
      expect(buildCreditGroups({ transactionType: TRANS_TYPE.VOID })[8]).toEqual([]);
      expect(buildCreditGroups({ transactionType: TRANS_TYPE.ADJUST, tipCents: 500 })[8]).toEqual(
        [],
      );
    });

    it('emits KEY=VALUE with no positional padding, unlike every other group', () => {
      const packet = buildPacket(
        COMMAND.DO_CREDIT,
        buildCreditGroups({ transactionType: TRANS_TYPE.SALE, amountCents: 102, tipPrompt: true }),
      );
      const body = packet.slice(1, packet.indexOf(ETX)).toString('ascii');
      // Last group, straight after the final FS, and with no US padding around it.
      expect(body.endsWith(`${String.fromCharCode(FS)}TIPREQ=1`)).toBe(true);
    });
  });

  it('puts an ADJUST tip in the tip slot, leaving the base amount alone', () => {
    const groups = buildCreditGroups({ transactionType: TRANS_TYPE.ADJUST, tipCents: 700 });
    const amount = groups[1] as string[];
    expect(amount[0]).toBe('');
    expect(amount[1]).toBe('700');
  });
});

describe('toPaxResult', () => {
  const approved = parsePacket(
    buildMockResponse([
      '0',
      'T00',
      PROTOCOL_VERSION,
      '000000',
      'APPROVED',
      ['000', 'OK', 'TEST01', '998877', '5', '1'],
      '01',
      ['4500', '', '500', '', '', '', '', ''],
      ['************4242', '1', '', '', '', '', 'VISA', '', '', '', '1'],
      ['123', '1', '20260811090000'],
    ]),
  );

  it('maps the fields the cloud needs', () => {
    const result = toPaxResult(approved, 4000);
    expect(result.result_code).toBe('000000');
    expect(result.result_text).toBe('APPROVED');
    expect(result.auth_code).toBe('TEST01');
    expect(result.card_type).toBe('VISA');
    expect(result.last_four).toBe('4242');
    expect(result.approved_amount_cents).toBe(4500);
    expect(result.tip_amount_cents).toBe(500);
    // ref_num is the TransactionNumber, since that is what VOID and ADJUST cite.
    expect(result.ref_num).toBe('123');
  });

  it('never forwards the masked PAN', () => {
    const serialised = JSON.stringify(toPaxResult(approved, 4000));
    expect(serialised).not.toContain('************4242');
    expect(serialised).toContain('4242'); // last four only
  });

  it('derives the tip from the total when the terminal itemises no tip', () => {
    const noTip = parsePacket(
      buildMockResponse([
        '0',
        'T00',
        PROTOCOL_VERSION,
        '000000',
        'APPROVED',
        [],
        '01',
        ['4500', '', '', '', '', '', '', ''],
      ]),
    );
    expect(toPaxResult(noTip, 4000).tip_amount_cents).toBe(500);
  });

  it('reports no tip when the approved amount matches what we asked for', () => {
    const exact = parsePacket(
      buildMockResponse([
        '0',
        'T00',
        PROTOCOL_VERSION,
        '000000',
        'APPROVED',
        [],
        '01',
        ['4000', '', '', '', '', '', '', ''],
      ]),
    );
    expect(toPaxResult(exact, 4000).tip_amount_cents).toBe(0);
  });
});
