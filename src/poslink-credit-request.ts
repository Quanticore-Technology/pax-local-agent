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
  /** Our external payment id, so the transaction is traceable in PAX reporting. */
  invoiceNumber?: string;
  /** TransactionNumber of the original sale — required by VOID and ADJUST. */
  origTransactionNumber?: string;
}

function emptyGroup(size: number): string[] {
  return new Array(size).fill('');
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
  // The sample defaults ReferenceNumber to "1" when the operator leaves it
  // blank; the terminal only uses it to echo the request back to us.
  trace[TRACE_REFERENCE] = fields.referenceNumber ?? '1';
  if (fields.invoiceNumber) {
    trace[TRACE_INVOICE] = fields.invoiceNumber;
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
    [], // additionalInformation
  ];
}
