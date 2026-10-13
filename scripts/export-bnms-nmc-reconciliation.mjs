// Read-only evidence snapshot. Never invokes provider or reconciliation services.
import { writeFile } from 'node:fs/promises';
import { connectDestination } from './lib/member-index-destination.mjs';
import { NMC_TENANT as tenant, NMC_FIELDS, projectNmcReport } from '../api/_lib/nmcMembershipReport.js';
import { MEMBERSHIP_RECOGNITION_TABLES } from '../api/_lib/alphaMembershipRecognition.js';
import { legacyExpiry } from './audit-bnms-non-dd-cohort.mjs';
const db = await connectDestination();
try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const read = async (table, where = 'tenant_id=$1', params = [tenant]) =>
    (await db.query(`SELECT to_jsonb(r) data FROM ${table} r WHERE ${where}`, params)).rows.map(r => r.data);
  const members = await read('member');
  const fields = await read('preference_field', "tenant_id=$1 AND entity_scope='member' AND is_active=true");
  const preferences = await read('member_preference_value', 'member_id=ANY($1::uuid[]) AND field_id=ANY($2::uuid[])',
    [members.map(m => m.id), fields.filter(f => [...NMC_FIELDS,'direct_debit_payment','ym_membership_type'].includes(f.name)).map(f => f.id)]);
  const value = (id, name) => preferences.find(p => p.member_id === id && p.field_id === fields.find(f => f.name === name)?.id)?.value || '';
  const history = await read('member_membership_history');
  const organizations = await read('organization');
  const agreements = await read('membership_billing_agreements');
  const plans = await read('membership_payment_plans');
  let recognitions = [];
  for (const table of MEMBERSHIP_RECOGNITION_TABLES) recognitions.push(...await read(table));
  const discoveries = await read('gocardless_mandate_discovery_row');
  const payments = await read('gocardless_payments');
  const historicalPayments = await read('bnms_dd_historical_payment');
  const base = { fields, preferences, history, organizations, agreements, recognitions, reportDate: '2026-10-13' };
  const rows = [];
  for (const m of members) {
    const klass = value(m.id, 'member_class');
    if (!['Full with NMC','Full junior with NMC'].includes(klass)) continue;
    const report = projectNmcReport({ ...base, members: [m] });
    if (report.total) continue;
    const h = history.filter(h => h.member_id === m.id);
    const a = agreements.filter(a => a.member_id === m.id || a.primary_contact_member_id === m.id);
    const p = plans.filter(p => p.member_id === m.id);
    const d = discoveries.filter(d => d.matched_member_id === m.id
      || (d.normalized_email && d.normalized_email === m.email?.trim().toLowerCase()));
    const mandates = new Set([...d.map(d => d.gocardless_mandate_id), ...a.map(a => a.gocardless_mandate_id), ...p.map(p => p.gocardless_mandate_id)].filter(Boolean));
    const pay = payments.filter(x => p.some(p => p.id === x.plan_id) || mandates.has(x.gocardless_mandate_id));
    const historic = historicalPayments.filter(x => x.member_id === m.id);
    const expiry = legacyExpiry(value(m.id, 'ym_date_membership_expires'));
    const days = expiry ? Math.floor((Date.parse(base.reportDate) - Date.parse(expiry)) / 86400000) : null;
    const dd = d.length || value(m.id,'direct_debit_payment') === 'true' || /DD/.test(value(m.id,'ym_membership_type'));
    const group = h.length ? 'Payment or setup review' : dd ? 'Direct Debit review'
      : days <= 90 ? 'Expired within 90 days' : 'Expired over 90 days';
    rows.push({
      memberId:m.id, name:[m.first_name,m.last_name].filter(Boolean).join(' '), email:m.email || '',
      memberClass:klass, customStatus:value(m.id,'membership_status'), membershipType:value(m.id,'ym_membership_type'),
      originalExpiry:value(m.id,'ym_date_membership_expires'), expiry, daysExpired:days, group,
      reason:Object.keys({...report.reviewCounts,...report.excludedCounts}).join('; '),
      history:h.map(x=>({status:x.status,paymentStatus:x.payment_status,start:x.term_start_date,end:x.term_end_date,
        paymentMethod:x.payment_method,invoiceNumber:x.accounting_invoice_number || x.xero_invoice_number || null,
        agreementId:x.billing_agreement_id})),
      agreements:a.map(x=>({id:x.id,provider:x.provider,environment:x.environment,status:x.status,
        attention:x.attention_reason,updated:x.updated_at})),
      plans:p.map(x=>({id:x.id,provider:x.provider,environment:x.environment,status:x.status,lastPaymentStatus:x.last_payment_status,
        lastPaymentAt:x.last_payment_at,instalmentsPaid:x.instalments_paid,attention:x.attention_reason})),
      discoveries:d.map(x=>({mandate:x.gocardless_mandate_id,status:x.mandate_status,environment:x.environment,checked:x.updated_at || x.created_at})),
      payments:pay.map(x=>({reference:x.gocardless_payment_id,status:x.status,environment:x.environment,date:x.charge_date,
        amountMinor:x.amount_minor,currency:x.currency,updated:x.updated_at})),
      historicalPaymentCount:historic.length, legacyDD:value(m.id,'direct_debit_payment'),
    });
  }
  if (rows.length !== 34 || new Set(rows.map(r=>r.memberId)).size !== 34) throw Error('Reconciliation cohort changed');
  rows.sort((a,b)=>a.group.localeCompare(b.group)||a.name.localeCompare(b.name));
  await db.query('COMMIT');
  await writeFile('/tmp/bnms-nmc-34-reconciliation.json', JSON.stringify({asOf:new Date().toISOString(),reportDate:base.reportDate,rows},null,2), {mode:0o600});
  console.log(JSON.stringify({count:rows.length,paymentCases:rows.filter(r=>r.group.includes('review')).map(({name,email,memberId,...rest})=>rest)},null,2));
} finally { await db.end(); }
