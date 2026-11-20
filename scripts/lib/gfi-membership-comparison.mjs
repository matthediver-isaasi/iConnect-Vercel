export const normalizeName = value => String(value || '').trim().replace(/\s+/gu, ' ').toLowerCase();
const cents = value => Number.isFinite(Number(value)) && value != null ? Math.round(Number(value) * 100) : null;
export function matchesPeriod(invoice, year) {
  const text = (invoice.LineItems || []).map(l => l.Description || '').join('\n');
  const [start, end] = year.split('/');
  return /\bmembership\b/i.test(text) && (
    new RegExp(`\\b${start}\\s*[/–—-]\\s*(?:${end}|${end.slice(2)})\\b`).test(text)
    || (new RegExp(`\\b${start}\\b`).test(text) && new RegExp(`\\b${end}\\b`).test(text))
  );
}
export function compareMembership(row, contacts, invoices, linkedIds) {
  const matchingContacts = contacts.filter(c => normalizeName(c.Name) === normalizeName(row.organization));
  const active = matchingContacts.filter(c => c.ContactStatus === 'ACTIVE');
  const ids = new Set(matchingContacts.map(c => c.ContactID));
  const candidates = invoices.filter(i => ids.has(i.Contact?.ContactID) && i.Type === 'ACCREC');
  const period = candidates.filter(i => matchesPeriod(i, row.membership_year));
  const exact = period.filter(i => i.CurrencyCode === row.currency
    && cents(i.SubTotal) === cents(row.final_cost)
    && cents(i.Total) === cents(row.total_with_vat)
    && cents(i.TotalTax) === cents(row.vat_amount));
  const live = exact.filter(i => !['VOIDED', 'DELETED'].includes(i.Status));
  const crossContact = invoices.filter(i => !ids.has(i.Contact?.ContactID) && i.Type === 'ACCREC'
    && matchesPeriod(i, row.membership_year) && i.CurrencyCode === row.currency
    && cents(i.SubTotal) === cents(row.final_cost) && cents(i.Total) === cents(row.total_with_vat));
  let finding;
  if (!matchingContacts.length) finding = 'No exact-name Xero contact; identity review required';
  else if (active.length !== 1 || matchingContacts.length !== 1) finding = 'Ambiguous or archived organisation contact';
  else if (live.length > 1) finding = 'Multiple matching invoices; duplicate review required';
  else if (live.length === 1 && linkedIds.has(live[0].InvoiceID)) finding = 'Matching invoice already linked elsewhere';
  else if (live.length === 1) finding = 'Unique exact membership invoice match';
  else if (exact.length) finding = 'Only voided/deleted exact matches';
  else if (period.length) finding = 'Membership period found; amounts or currency differ';
  else finding = 'No evidenced membership-period match under exact-name contact';
  return { finding, matches: live, candidates: period, contactInvoices: candidates,
    otherContactSameAmounts: crossContact.length };
}
