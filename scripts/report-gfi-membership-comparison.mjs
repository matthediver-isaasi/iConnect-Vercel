import fs from 'node:fs/promises';
const dir = 'generated-artifacts/gfi-membership-xero-comparison';
const evidence = JSON.parse(await fs.readFile(`${dir}/evidence.json`, 'utf8'));
const { results, summary } = evidence;
const money = value => Math.round(Number(value) * 100);
const csv = rows => rows.map(row => row.map(value =>
  `"${String(value ?? '').replace(/^[=+@-]/, "'$&").replaceAll('"', '""')}"`).join(',')).join('\r\n') + '\r\n';
const columns = ['Organisation', 'Membership year', 'Finding', 'Expected net', 'Expected VAT', 'Expected total',
  'Invoice numbers', 'Xero statuses', 'Xero net amounts', 'Xero VAT amounts', 'Xero totals', 'Xero balances',
  'Same-total opening balances (not proven membership invoices)', 'Existing application payment status',
  'Organisation ID', 'History ID'];
for (const [name, subset] of [
  ['full-comparison', results],
  ['exact-matches', results.filter(r => r.finding === 'Unique exact membership invoice match')],
  ['review-required', results.filter(r => r.finding !== 'Unique exact membership invoice match')],
]) {
  const rows = subset.map(r => {
    const candidates = r.periodCandidates;
    const opening = r.contactInvoices.filter(i => money(i.total) === money(r.total_with_vat)
      && i.lines?.some(l => /opening balance/i.test(l.description)));
    return [r.organization, r.membership_year, r.finding, r.final_cost, r.vat_amount, r.total_with_vat,
      ...['number', 'status', 'net', 'tax', 'total', 'due'].map(k => candidates.map(i => i[k]).join('; ')),
      opening.map(i => `${i.number} (${i.status})`).join('; '), r.payment_status, r.organization_id, r.id];
  });
  await fs.writeFile(`${dir}/${name}.csv`, csv([columns, ...rows]));
}
const unique = results.filter(r => r.finding === 'Unique exact membership invoice match');
if (new Set(unique.map(r => r.matchedInvoices[0].id)).size !== unique.length) throw new Error('Invoice reused across targets');
const unmatched = results.filter(r => r.finding === 'No evidenced membership-period match under exact-name contact');
const opening = unmatched.filter(r => r.contactInvoices.some(i => money(i.total) === money(r.total_with_vat)
  && i.lines?.some(l => /opening balance/i.test(l.description))));
const overview = { ...summary, exactPaidMatches: unique.filter(r => r.matchedInvoices[0].status === 'PAID').length,
  exactMatchGross: unique.reduce((s, r) => s + money(r.total_with_vat), 0) / 100,
  sameTotalOpeningBalanceCases: opening.length,
  otherUnmatchedCases: unmatched.filter(r => !opening.includes(r)).map(r => r.organization),
  limitations: [
    'Read-only comparison, not authorization to link invoices or create financial transactions.',
    'Exact means unique normalized organisation name plus membership period, currency, net, VAT and total.',
    'Opening balances lack sufficient membership-period and tax evidence for automatic linkage.',
    'No period match does not prove no invoice was issued: descriptions or contact identity may differ.',
    'Xero status PAID was observed; credit notes and settlement allocation were not audited.',
    'Scope: 156 existing GFI organisations with unlinked chargeable 2025/2026 history; excludes orphaned rows.',
  ] };
await fs.writeFile(`${dir}/summary.json`, JSON.stringify(overview, null, 2));
console.log(JSON.stringify(overview, null, 2));
