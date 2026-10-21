// Offline report and evidence-integrity checks; never connects to a provider.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const dir = 'generated-artifacts/bnms-other-test-accounting';
const e = JSON.parse(fs.readFileSync(`${dir}/evidence.json`));
const s = JSON.parse(fs.readFileSync(`${dir}/snapshot.json`));
assert.equal(e.complete, true);
assert.equal(e.stripe.length + e.excluded.length, s.membership_instalment_invoices.length);
assert.equal(e.gocardless.length, s.gocardless_payments.length);
assert(e.stripe.every(x => x.provider && x.provider.id === x.row.external_payment_id
  && x.provider.subscription === x.agreement.stripe_subscription_id
  && x.provider.amount_paid === x.row.amount_minor
  && x.provider.currency.toUpperCase() === x.row.currency.toUpperCase()
  && x.provider.livemode === x.provider.subscription_livemode));
assert(e.gocardless.every(x => x.provider && x.provider.id === x.row.gocardless_payment_id));
const tests = e.stripe.filter(x => x.provider.livemode === false)
  .sort((a,b) => a.row.accounting_invoice_number.localeCompare(b.row.accounting_invoice_number));
const old = s.membership_instalment_invoices.filter(x => e.excluded.includes(x.accounting_invoice_number));
const xinvoice = row => e.invoices.find(i => i.InvoiceID === row.accounting_invoice_id);
const esc = v => String(v ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const money = v => Number(v || 0).toFixed(2);
const table = (headers, rows) => `<table><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
const rows = tests.map(x => {
  const i = xinvoice(x.row);
  assert(i && i.InvoiceNumber === x.row.accounting_invoice_number && i.Total * 100 === x.row.amount_minor);
  const previous = old.find(o => o.billing_agreement_id === x.row.billing_agreement_id);
  assert(previous, 'Test-purpose owner confirmation must be linked by agreement');
  return { invoice: i.InvoiceNumber, id: i.InvoiceID, contact: i.Contact.Name,
    amount: i.Total, status: i.Status, paid: i.AmountPaid, due: i.AmountDue,
    credited: i.AmountCredited, email: x.provider.customer_email, stripe: x.provider.id,
    subscription: x.provider.subscription, subscriptionStatus: x.provider.subscription_status,
    agreement: x.agreement.id, signedUp: x.agreement.created_at, prior: previous.accounting_invoice_number,
    payments: e.payments.filter(p => p.Invoice?.InvoiceID === i.InvoiceID) };
});
const mismatches = e.gocardless.filter(x => x.row.environment !== x.lookup.environment);
const allLinks = [...e.stripe,...e.gocardless].filter(x=>x.row.accounting_invoice_id);
assert(allLinks.every(x=>xinvoice(x.row)), 'Every accounting link needs a provider invoice');
const total = rows.reduce((sum,r)=>sum+Math.round(r.amount*100),0)/100;
assert(rows.every(r => r.status === 'VOIDED' && r.paid === 0 && r.due === 0),
  'Financial findings changed; revise report narrative before delivery');
assert(e.gocardless.every(x => x.lookup.environment === 'live'
  && (x.row.amount_minor === null || x.row.amount_minor === x.provider.amount)));
const report = `<!doctype html><html lang="en"><meta charset="utf-8"><title>BNMS test-payment accounting audit</title>
<style>body{font:15px system-ui,sans-serif;color:#172033;margin:32px;max-width:1500px}h1,h2{color:#123c62}table{border-collapse:collapse;width:100%;margin:18px 0;font-size:12px}th,td{border:1px solid #ccd4df;padding:8px;text-align:left;overflow-wrap:anywhere}th{background:#edf2f7}section{margin:30px 0}.note{padding:16px;background:#fff5d9}small{color:#546175}@media print{body{margin:10px}tr{break-inside:avoid}}</style>
<h1>BNMS: additional test payments in Xero</h1><p>Read-only evidence captured ${esc(e.at)} (UTC). DEST only; tenant-owned Stripe, GoCardless and Xero credentials. No financial or subscription mutations, and no OAuth refresh.</p>
<p class="note"><b>${rows.length} additional provider-confirmed Stripe test invoices, totalling £${money(total)}. All are already VOIDED in Xero, with £0 paid and £0 due.</b> These September invoices are distinct from the 16 October invoices in the approved cleanup. Original test intent is established by an exact billing-agreement match to the owner-confirmed signups—not by a contact name or email guess. No further reversal is indicated by their current invoice balances. This audit did not establish who voided them or when any prior payments were removed.</p>
<h2>Affected invoices and current Xero financial state</h2>
${table(['Invoice','Xero contact (current)','Total GBP','Status','Paid GBP','Due GBP','Credited GBP','Payment status / reconciled'], rows.map(r=>[r.invoice,r.contact,money(r.amount),r.status,money(r.paid),money(r.due),money(r.credited),r.payments.map(p=>`${p.PaymentID}: ${p.Status}; reconciled=${p.IsReconciled}; £${money(p.Amount)}`).join('\n')||'No payment returned']))}
<h2>Original intent and provider chain</h2><p>Every row below was retrieved using the tenant’s Stripe test key: invoice.livemode=false and subscription.livemode=false. Stripe invoice status was paid. “Paid” in Stripe test mode is simulated money, not live settlement. Current Xero contact details are mutable; original Stripe invoice email and persisted signup time are provided separately. All subscriptions were already canceled when read; this audit did not cancel them.</p>
${table(['Invoice / Xero ID','Original Stripe invoice email','Signup UTC','Stripe invoice / subscription','Agreement ID','Previously approved October invoice'],rows.map(r=>[`${r.invoice}\n${r.id}`,r.email,r.signedUp,`${r.stripe}\n${r.subscription}`,r.agreement,r.prior]))}
<h2>GoCardless findings</h2><p>All ${e.gocardless.length} local payment references were looked up against the tenant-owned ${esc(e.gocardless[0]?.lookup.environment)} GoCardless endpoint. ${e.gocardless.filter(x=>x.provider).length} resolved. Provider endpoint evidence takes precedence over a contradictory local label. No sandbox-origin payment was established by these provider reads.</p>
${table(['Local invoice','Payment ID','Local environment','Provider environment / status','Amount minor units','Accounting state'],mismatches.map(x=>[x.row.accounting_invoice_number||'No invoice link',x.row.gocardless_payment_id,x.row.environment,`${x.lookup.environment} / ${x.provider.status}`,x.provider.amount, xinvoice(x.row)?`${xinvoice(x.row).Status}; paid £${money(xinvoice(x.row).AmountPaid)}; due £${money(xinvoice(x.row).AmountDue)}`:'No linked accounting invoice']))}
<p>A live payment can still have been deliberately made for testing, but neither a sandbox database label nor a recognisable name establishes that intent. No owner confirmation of these Direct Debit payments was found in the supplied historical test evidence. Do not reverse them on the strength of the local environment label.</p>
<h2>Coverage and limits</h2><ul><li>${s.membership_instalment_invoices.length} instalment ledger rows counted and read exhaustively: 16 already-approved invoices excluded from provider re-audit; ${e.stripe.length} additional Stripe invoices checked (${tests.length} test, ${e.stripe.length-tests.length} live).</li>
<li>${s.gocardless_payments.length} GoCardless payment rows counted and read exhaustively, including unlinked payments; ${e.gocardless.filter(x=>x.row.accounting_invoice_id).length} accounting-linked rows.</li>
<li>${e.invoices.length} distinct Xero invoices retrieved by exact IDs without a contact-name filter. Every linked row resolved. A failed local sync status was not treated as proof that no invoice existed.</li>
<li>All reads bounded; row caps fail closed. SQL ran in a repeatable-read, read-only transaction. Provider observations are timestamped reads, not a cross-provider atomic snapshot.</li>
<li>This covers the membership instalment ledger and GoCardless payment accounting links. It is not a claim that all historical Xero invoices, unrelated payment products, or unrecorded/orphan provider invoices were scanned.</li>
<li>Provider mode proves whether money is simulated, not human intent. The 16 Stripe findings have separate owner-confirmed intent through matching agreements; the Direct Debit discrepancy does not.</li>
<li>No database migrations were needed or applied. No cleanup cohort was rerun.</li></ul>
<h2>Verified live Stripe controls</h2>
${table(['Invoice','Stripe ID','Live mode','Xero status','Total GBP'],e.stripe.filter(x=>x.provider.livemode).map(x=>[x.row.accounting_invoice_number,x.provider.id,true,xinvoice(x.row)?.Status,money(xinvoice(x.row)?.Total)]))}
<h2>All audited accounting links</h2><p>This appendix retains exact local/provider identifiers for review; it does not authorize any change.</p>
${table(['Rail','Provider payment / invoice','Provider mode','Xero invoice / ID','Xero status','Total / paid / due GBP'],allLinks.map(x=>{const i=xinvoice(x.row);return [x.row.provider||'gocardless',x.row.external_payment_id||x.row.gocardless_payment_id,x.provider?.livemode===false?'test':x.lookup?.environment||'live',`${i.InvoiceNumber}\n${i.InvoiceID}`,i.Status,`${money(i.Total)} / ${money(i.AmountPaid)} / ${money(i.AmountDue)}`]}))}
</html>`;
fs.writeFileSync(`${dir}/report.html`, report, { mode: 0o600 });
fs.writeFileSync(`${dir}/affected-invoices.json`, JSON.stringify(rows,null,2), { mode: 0o600 });
console.log(JSON.stringify({checked:true,affected:rows.length,total,statuses:[...new Set(rows.map(r=>r.status))],
  gcLabelMismatches:mismatches.map(x=>({id:x.row.gocardless_payment_id,invoice:x.row.accounting_invoice_number,actual:x.lookup.environment,status:x.provider.status})),
  report:`${dir}/report.html`}));
