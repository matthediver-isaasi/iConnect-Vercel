import { buildXeroSalesInvoicePayload } from './xero.js';
import { buildQuickBooksSalesInvoicePayload } from './quickbooks.js';
import { prepareAccountingRequestEnvelope } from './accountingRequestProviders.js';
import { accountingQueueEnabled } from './accountingQueueIntegration.js';

// Staged source opt-in: unsupported products remain on their existing writer,
// even when the shared queue is enabled for membership or commercial sales.
export function productAccountingQueueEnabled(sourceType) {
  return accountingQueueEnabled()
    && (process.env.ACCOUNTING_REQUEST_QUEUE_SOURCES || '').split(',').map(value => value.trim()).includes(sourceType)
    && sourceType === 'sales_commercial_sale';
}

// Pure preparation only. Both builders enforce representability of accepted
// line economics; replay never loads current products, tax mappings or prices.
export function prepareSalesAccountingEnvelope({ provider, payload, environment }) {
  const body = provider === 'xero'
    ? buildXeroSalesInvoicePayload(payload).Invoices[0]
    : provider === 'quickbooks' ? buildQuickBooksSalesInvoicePayload(payload) : null;
  if (!body) throw new Error('Unsupported sales accounting provider');
  const fields = provider === 'xero' ? {
    Type: body.Type, Status: body.Status, LineAmountTypes: body.LineAmountTypes,
    LineItems: body.LineItems,
    SubTotal: payload.netMinor / 100, TotalTax: payload.taxMinor / 100,
  } : {
    GlobalTaxCalculation: body.GlobalTaxCalculation,
    Line: body.Line,
    TxnTaxDetail: { TotalTax: payload.taxMinor / 100 },
  };
  return prepareAccountingRequestEnvelope({
    provider, operationKey: payload.idempotencyKey, payload: body, environment,
    expected: { contactId: payload.customerId, currency: payload.currency,
      totalMinor: payload.grossMinor, fields },
  });
}