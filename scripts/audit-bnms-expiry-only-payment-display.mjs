// Read-only cohort assessment; invoice presence is not provider verification.
import fs from 'node:fs';
import { connectDestination } from './annual-meeting-destination.mjs';
process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
const { selectCanvasCommitment, buildCanvasSummary } = await import('../api/membership/canvas-summary.js');
const { currentMembershipRecognition, MEMBERSHIP_RECOGNITION_TABLES } = await import('../api/_lib/alphaMembershipRecognition.js');
const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const db = await connectDestination();
try {
  await db.query('BEGIN READ ONLY');
  const read = async table => (await db.query(`select to_jsonb(t) data from ${table} t where tenant_id=$1`, [tenant])).rows.map(r => r.data);
  const histories = await read('member_membership_history');
  const organisations = await read('organisation_membership_history');
  const members = (await db.query('select id,first_name,last_name,organization_id,membership_paused from member where tenant_id=$1', [tenant])).rows;
  const invoices = await read('historical_member_invoice');
  const recognitions = [];
  for (const table of MEMBERSHIP_RECOGNITION_TABLES) recognitions.push(...await read(table));
  const today = new Date().toISOString().slice(0,10);
  const affected = [];
  let cohortMembers = 0;
  for (const m of members) {
    const personal = histories.filter(h => h.member_id === m.id).map(h => ({ ...h, membership_source: 'personal' }));
    for (const h of personal) {
      for (const r of recognitions.filter(r => r.history_id === h.id)) {
        if (currentMembershipRecognition({ ...h, membershipRecognition: r }, today)) h.membershipRecognition = r;
      }
    }
    const sourceOf = h => { try { return JSON.parse(h.notes)?.source || 'other'; } catch { return 'other'; } };
    const sameCohort = personal.some(h => sourceOf(h) === 'bnms_corrected_expiry_operator_attestation');
    if (sameCohort) cohortMembers++;
    const org = organisations.filter(h => m.organization_id && h.organization_id === m.organization_id)
      .map(h => ({ ...h, membership_source: 'organisation' }));
    const selected = selectCanvasCommitment(personal, org, today);
    const h = selected?.record;
    // Same root cause: a paid, annual, upfront, expiry-only personal history
    // selected by the portal, without a linked billing agreement.
    if (!h || h.membership_source !== 'personal' || h.term_start_date || !h.term_end_date
      || h.billing_agreement_id || h.billing_period !== 'annual' || h.payment_method !== 'upfront'
      || h.payment_status !== 'paid') continue;
    const summary = buildCanvasSummary({ selected, today, paused: m.membership_paused === true });
    if (summary.payment.state !== 'unavailable') continue;
    const linked = invoices.filter(i => i.member_id === m.id && /membership/i.test(i.description || ''));
    affected.push({ memberId:m.id, name:`${m.first_name} ${m.last_name}`, historyId:h.id, source:sourceOf(h),
      expiry:h.term_end_date, unexpired:h.term_end_date >= today, membershipState:summary.membership.state,
      invoiceReferences:linked.map(i => ({ number:i.invoice_number, date:i.invoice_date,
        description:i.description, status:i.accounting_payment_status || i.status, xeroId:i.xero_document_id })) });
  }
  await db.query('ROLLBACK');
  const cohort = affected.filter(h => h.source === 'bnms_corrected_expiry_operator_attestation');
  const counts = rows => ({ members:rows.length, unexpired:rows.filter(r=>r.unexpired).length,
    withMembershipInvoice:rows.filter(r=>r.invoiceReferences.length).length,
    withoutMembershipInvoice:rows.filter(r=>!r.invoiceReferences.length).length,
    withPaidMembershipInvoice:rows.filter(r=>r.invoiceReferences.some(i=>i.status==='paid')).length });
  const result = { checkedAt:new Date().toISOString(), cohortMembers, sameCorrectionCohort:counts(cohort),
    allSelectedExpiryOnlyUpfront:counts(affected), bySource:Object.fromEntries([...new Set(affected.map(r=>r.source))].map(s=>[s,counts(affected.filter(r=>r.source===s))])) };
  const dir='generated-artifacts/bnms-expiry-only-audit';
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  fs.writeFileSync(`${dir}/audit.json`,JSON.stringify({ ...result, affected },null,2),{mode:0o600});
  console.log(JSON.stringify(result));
} finally { await db.end(); }
