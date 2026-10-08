const fail = message => { throw new Error(`Credit note needs review: ${message}`); };

function minor(value, label) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) {
    fail(`${label} is missing or invalid`);
  }
  const amount = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(amount) || amount < 0) fail(`${label} is invalid`);
  return amount;
}

// Cancellation amounts are gross. Use the historical invoice, never today's tax
// settings or the first line's tax code for a whole mixed-tax invoice.
export function buildXeroCreditAmounts(invoice, creditAmount, description) {
  const gross = minor(creditAmount, 'credit amount');
  const total = minor(invoice.Total, 'invoice total');
  const tax = minor(invoice.TotalTax, 'invoice tax');
  if (!gross || gross > total || tax > total) fail('credit exceeds the original invoice');
  if (!['Inclusive', 'Exclusive', 'NoTax'].includes(invoice.LineAmountTypes)) fail('unknown invoice tax basis');
  if (!invoice.CurrencyCode) fail('invoice currency is missing');
  const lines = (invoice.LineItems || []).map(line => {
    const amount = minor(line.LineAmount, 'line amount');
    const lineTax = minor(line.TaxAmount, 'line tax');
    const lineGross = amount + (invoice.LineAmountTypes === 'Exclusive' ? lineTax : 0);
    if (lineTax > lineGross || (invoice.LineAmountTypes === 'NoTax' && lineTax)) fail('inconsistent line tax');
    if (!lineGross && !lineTax) return null;
    if (!line.AccountCode || !line.TaxType) fail('original line accounting details are missing');
    return { line, gross: lineGross, tax: lineTax };
  }).filter(Boolean);
  if (!lines.length || lines.reduce((sum, line) => sum + line.gross, 0) !== total
    || lines.reduce((sum, line) => sum + line.tax, 0) !== tax) fail('invoice lines do not reconcile');

  const makeLine = (source, grossMinor, taxMinor) => ({
    Description: description || source.Description || 'Credit note for cancelled booking',
    Quantity: 1,
    UnitAmount: grossMinor / 100,
    TaxAmount: taxMinor / 100,
    TaxType: source.TaxType,
    AccountCode: source.AccountCode,
    ...(source.Tracking?.length ? { Tracking: source.Tracking } : {}),
  });

  let creditLines;
  if (gross === total) {
    creditLines = lines.map(item => makeLine(item.line, item.gross, item.tax));
  } else {
    // The caller supplies only a gross amount, not cancelled invoice-line IDs.
    // A partial mixed-tax/account credit cannot safely be assigned to a line.
    const signature = line => JSON.stringify([line.TaxType, line.AccountCode, line.Tracking || []]);
    if (lines.some(item => signature(item.line) !== signature(lines[0].line)
      || Math.abs(item.tax - Math.round(item.gross * tax / total)) > 1)) {
      fail('partial credit requires original line allocation for mixed tax or accounting codes');
    }
    creditLines = [makeLine(lines[0].line, gross, Math.round(gross * tax / total))];
  }
  return { LineAmountTypes: 'Inclusive', CurrencyCode: invoice.CurrencyCode, LineItems: creditLines };
}

export function assertXeroCreditTotal(creditNote, expectedAmount, currency, expectedTax) {
  if (creditNote.HasErrors || creditNote.ValidationErrors?.length
    || minor(creditNote.Total, 'returned credit total') !== minor(expectedAmount, 'expected credit')
    || creditNote.CurrencyCode !== currency
    || (expectedTax !== undefined && minor(creditNote.TotalTax, 'returned credit tax') !== minor(expectedTax, 'expected tax'))) {
    fail('Xero credit total, tax or currency differs from the intended credit; do not retry blindly');
  }
}
