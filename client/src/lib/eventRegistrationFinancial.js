export const PAYMENT_METHOD_LABELS = Object.freeze({
  public_invoice_po: 'Invoice / PO',
  card: 'Stripe',
  account: 'Account',
  account_balance: 'Account Balance',
  invoice: 'Invoice',
  voucher: 'Voucher',
  training_fund: 'Training Fund',
  free: 'Free',
  admin_import: 'Imported (financial history unavailable)',
});

export function paymentMethodLabel(method) {
  return PAYMENT_METHOD_LABELS[method] || 'Unknown';
}

export function financialAmount(value) {
  return value == null || value === '' || !Number.isFinite(Number(value))
    ? null
    : Number(value);
}

export function financialExport(value) {
  const amount = financialAmount(value);
  return amount === null ? 'Unavailable' : amount.toFixed(2);
}

export function financialCurrency(value) {
  const amount = financialAmount(value);
  return amount === null ? 'Unavailable' : `£${amount.toFixed(2)}`;
}