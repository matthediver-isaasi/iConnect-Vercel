// Exact owner-approved cohort only; defaults to rollback. No provider calls.
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
const ids = ['8d11925e-4218-435a-bccc-9061bf5b8bdb','6ea6a50c-7155-4aae-9034-c00a66918e29','eaa4f068-71fc-43f9-af4c-b1e518a3be16','fad8579a-6a29-44c8-bb42-a6f7cfb29327'];
const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const quote = s => `"${s.replaceAll('"','""')}"`;
assert(process.argv.slice(2).every(x => x === '--apply'), 'Invalid arguments');
const target = destinationTarget(process.env);
const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
assert(response.ok, 'CA unavailable');
const client = new pg.Client({ connectionString: target.toString(), ssl: { rejectUnauthorized: true, ca: await response.text(), servername: target.hostname } });
try {
  await client.connect();
  await client.query("BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='20s'");
  await client.query('LOCK TABLE public.membership_payment_plans,public.membership_billing_agreements,public.gocardless_payments,public.member_membership_history IN SHARE ROW EXCLUSIVE MODE');
  const get = async (table, column, values) => (await client.query(`SELECT * FROM public.${quote(table)} WHERE ${quote(column)}=ANY($1::uuid[]) AND tenant_id=$2 FOR UPDATE`, [values, tenant])).rows;
  const plans = await get('membership_payment_plans', 'id', ids);
  assert(plans.length === 4 && plans.every(p => p.environment === 'sandbox' && p.status === 'active'), 'Plan drift');
  const agreementIds = [...new Set(plans.map(p => p.billing_agreement_id))];
  assert(agreementIds.length === 4, 'Agreement scope drift');
  const members = (await client.query("SELECT id FROM public.member WHERE id=ANY($1::uuid[]) AND tenant_id=$2 AND email LIKE 'deleted_%@deleted.local'", [plans.map(p=>p.member_id),tenant])).rows;
  assert(members.length === 4, 'Member identity drift');
  const agreements = await get('membership_billing_agreements','id',agreementIds);
  assert(agreements.length === 4 && agreements.every(a => a.environment === 'sandbox' && plans.find(p=>p.billing_agreement_id===a.id)?.member_id===a.member_id), 'Agreement drift');
  const payments = await get('gocardless_payments','plan_id',ids);
  assert(payments.length === 4 && payments.every(p=>p.environment==='sandbox' && p.status==='paid_out'), 'Payment drift');
  const histories = await get('member_membership_history','billing_agreement_id',agreementIds);
  assert(histories.length === 4 && histories.every(h=>!h.xero_invoice_id && !h.accounting_invoice_id), 'History drift');
  const groups = { membership_payment_plans: ids, membership_billing_agreements: agreementIds, gocardless_payments: payments.map(p=>p.id), member_membership_history: histories.map(h=>h.id) };
  const triggers = (await client.query(`SELECT t.tgname,p.proname FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relname=ANY($1) AND NOT t.tgisinternal AND (t.tgtype::int & 8)>0`,[Object.keys(groups)])).rows;
  assert(triggers.length===6 && triggers.every(t=>['bnms_dd_alpha_canonical_guard','bnms_manual_canonical_guard','bnms_dd_alpha_hold_guard'].includes(t.proname)), 'Delete trigger drift');
  const rules = await client.query('SELECT 1 FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class WHERE c.relname=ANY($1)',[Object.keys(groups)]);
  assert(rules.rowCount===0,'Unexpected rules');
  const fks = (await client.query(`SELECT n.nspname schema,ch.relname child,a.attname col,p.relname parent,cardinality(con.conkey) size FROM pg_constraint con JOIN pg_class ch ON ch.oid=con.conrelid JOIN pg_namespace n ON n.oid=ch.relnamespace JOIN pg_class p ON p.oid=con.confrelid JOIN pg_attribute a ON a.attrelid=ch.oid AND a.attnum=con.conkey[1] WHERE con.contype='f' AND con.confrelid=ANY(ARRAY['public.membership_payment_plans'::regclass,'public.membership_billing_agreements'::regclass,'public.gocardless_payments'::regclass,'public.member_membership_history'::regclass])`)).rows;
  for (const f of fks) {
    assert(f.size===1,'Composite dependency drift');
    // External dependency tables need not have an id column.
    const allowed = f.schema==='public' && groups[f.child];
    const extra = allowed ? ' AND NOT (id=ANY($2::uuid[]))' : '';
    const args = allowed ? [groups[f.parent],allowed] : [groups[f.parent]];
    const result = await client.query(`SELECT count(*)::int n FROM ${quote(f.schema)}.${quote(f.child)} WHERE ${quote(f.col)}=ANY($1::uuid[])${extra}`,args);
    assert(result.rows[0].n===0,`Unapproved dependency: ${f.child}`);
  }
  const deleted = {};
  for (const table of ['gocardless_payments','member_membership_history','membership_payment_plans','membership_billing_agreements']) {
    const result = await client.query(`DELETE FROM public.${quote(table)} WHERE id=ANY($1::uuid[]) AND tenant_id=$2 RETURNING id`,[groups[table],tenant]);
    assert(result.rowCount===4,'Deletion count mismatch');
    deleted[table]=result.rowCount;
  }
  const apply = process.argv.includes('--apply');
  await client.query(apply ? 'COMMIT' : 'ROLLBACK');
  console.log(JSON.stringify({committed:apply,deleted,at:new Date().toISOString(),destination:'lvmzliemqnieeoruhkik'}));
} catch (error) {
  await client.query('ROLLBACK').catch(()=>{});
  console.error(JSON.stringify({committed:false,error:error.message,code:error.code}));
  process.exitCode=1;
} finally { await client.end(); }