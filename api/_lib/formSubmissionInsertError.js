// P0001 is a generic PostgreSQL exception, not evidence of a stock shortage.
// Keep known invoice-guard failures out of the cart's stock-recovery UI.
export function invoiceOrderInsertFailure(error) {
  if (error?.code !== 'P0001' || error?.message !== 'Accepted invoice order is immutable') return null;
  return {
    status: 409,
    body: {
      code: 'INVOICE_ORDER_VALIDATION_FAILED',
      error: 'We could not confirm your invoice order. Your answers have been kept. Please contact the team before trying again.',
    },
  };
}
