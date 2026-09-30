/**
 * Builds the group array for a DoCredit (T00) packet.
 *
 * T00 carries nine positional groups after Command and Version. Every group
 * must be present even when empty, because the terminal reads them by position:
 *
 *   transactionType │ amount │ account │ trace │ avs │ cashier │ commercial │
 *   motoEcommerce │ additional
 *
 * Field order within each group is taken from PAX's JavaScript sample
 * (`js/main.js`, `GetConfigureData()`). Only the fields we actually populate
 * are named here; the rest stay empty so later positions stay aligned.
 */
import type { PacketGroup } from './poslink-protocol';

/** Positions inside the amountInformation group. */
const AMOUNT_FIELDS = 6; // TransactionAmount, Tip, CashBack, MerchantFee, Tax, Fuel
const AMOUNT_TRANSACTION = 0;
const AMOUNT_TIP = 1;

/** Positions inside the traceInformation group. */
const TRACE_FIELDS = 6; // Reference, Invoice, AuthCode, TransactionNumber, TimeStamp, ECRTransID
const TRACE_REFERENCE = 0;
const TRACE_INVOICE = 1;
const TRACE_TRANSACTION_NUMBER = 3;

export interface CreditRequestFields {
  /** One of TRANS_TYPE — SALE, RETURN, ADJUST, VOID… */
  transactionType: string;
  /** Base amount in cents. Omitted for operations that carry no amount. */
  amountCents?: number;
  /** Tip in cents — used by ADJUST, where it is the only amount that changes. */
  tipCents?: number;
  /** ECR-side sequence number. The terminal echoes it back for matching. */
  referenceNumber?: string;
  /**
   * Our external payment id, so the transaction is traceable in PAX reporting.
   * Folded to 12 digits by `toInvoiceNumber` — PAX rejects anything else.
   */
  invoiceNumber?: string;
  /** TransactionNumber of the original sale — required by VOID and ADJUST. */
  origTransactionNumber?: string;
  /**
   * Ask the terminal to prompt the customer for a tip on its own screen.
   * Without this the prompt depends entirely on the tip settings configured in
   * BroadPOS on the device, which we cannot see or control from here.
   */
  tipPrompt?: boolean;
}

function emptyGroup(size: number): string[] {
  return new Array(size).fill('');
}

/**
 * PAX accepts only digits in InvoiceNumber, at most 12 of them. Anything else
 * makes the terminal reject the whole request with "INVOICE INVALID" before it
 * even prompts for a card.
 *
 * Our external payment ids are UUIDs, so fold the UUID's hex digits into a
 * 12-digit number. The mapping is deterministic, so a row in PAX's batch report
 * can still be traced back to a payment by recomputing this from its
 * external_payment_id.
 */
const INVOICE_DIGITS = 12;
const INVOICE_MODULUS = 1_000_000_000_000n; // 10^12 — one more digit than we emit

export function toInvoiceNumber(externalId: string): string {
  // Already a legal invoice number — pass it through so hand-set ids stay readable.
  if (/^\d{1,12}$/.test(externalId)) return externalId;

  // 16 hex chars (64 bits) is well past 10^12, so the modulus does the real work.
  const hex = externalId.replace(/[^0-9a-f]/gi, '').slice(0, 16);
  if (!hex) return ''; // nothing numeric to work with — send no invoice at all

  return (BigInt(`0x${hex}`) % INVOICE_MODULUS).toString().padStart(INVOICE_DIGITS, '0');
}

/**
 * ReferenceNumber for the trace group. A constant "1" on every request let the
 * terminal (and its batch report) confuse one transaction with another, so it
 * is derived from our own id instead: the same fold as the invoice number,
 * last 8 digits, leading zeros dropped. Sales use external_id, so a retried
 * sale keeps its reference; other commands use the request id.
 */
export function toReferenceNumber(id: string): string {
  const folded = toInvoiceNumber(id).slice(-8).replace(/^0+/, '');
  return folded || '1'; // an all-zero fold is not a usable reference
}

/**
 * `additionalInformation` is the one group the terminal reads by NAME rather
 * than by position: every entry is `KEY=VALUE`, and a key we don't send is
 * simply absent — no placeholder needed. Key names come from PAX's sample
 * (`js/main.js`, `GetConfigureData()`).
 *
 * TIPREQ=1 is "need enter tip on terminal" per `pax.html`'s TipRequest select.
 */
function buildAdditionalInformation(fields: CreditRequestFields): string[] {
  const entries: string[] = [];
  if (fields.tipPrompt) entries.push('TIPREQ=1');
  return entries;
}

export function buildCreditGroups(fields: CreditRequestFields): PacketGroup[] {
  const amount = emptyGroup(AMOUNT_FIELDS);
  if (fields.amountCents !== undefined) {
    amount[AMOUNT_TRANSACTION] = String(fields.amountCents);
  }
  if (fields.tipCents !== undefined) {
    amount[AMOUNT_TIP] = String(fields.tipCents);
  }

  const trace = emptyGroup(TRACE_FIELDS);
  // Callers pass toReferenceNumber(); "1" is PAX's sample default.
  trace[TRACE_REFERENCE] = fields.referenceNumber ?? '1';
  if (fields.invoiceNumber) {
    trace[TRACE_INVOICE] = toInvoiceNumber(fields.invoiceNumber);
  }
  if (fields.origTransactionNumber) {
    trace[TRACE_TRANSACTION_NUMBER] = fields.origTransactionNumber;
  }

  return [
    fields.transactionType,
    amount,
    [], // accountInformation — card is read on the terminal, never sent by us
    trace,
    [], // avsInformation
    [], // cashierInformation
    [], // commercialInformation
    [], // motoEcommerce
    buildAdditionalInformation(fields),
  ];
}
