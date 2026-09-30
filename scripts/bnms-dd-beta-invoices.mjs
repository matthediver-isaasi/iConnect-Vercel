// Append-only reconciliation of existing settled payments to existing Xero invoices.
// Never create invoices, payments, entitlements, or release collections.
import { createHash } from 'node:crypto';
export const TENANT_ID='ff2df806-b321-4254-b651-3af11fccf1db';
export const XERO_TENANT_ID='3d57dce6-2205-462f-abf6-9c7cbf00be23';
export const BATCH_HASH='aaeb5efa50de77db5b6213c23d32a71ae0aa19d88484f1afd911f49fa44739c2';
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
export const hash=v=>createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
export const sqlHash=sql=>createHash('sha256').update(sql).digest('hex');
const fail=m=>{throw Error(m);};
const norm=v=>String(v||'').trim().toLowerCase();
const minor=v=>v===null||v===undefined||!Number.isFinite(Number(v))?NaN:Math.round(Number(v)*100);
const uuid=v=>/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v||'');
const day=v=>String(v).slice(0,10);

async function invoiceSchemaCatalogHash(c) {
  const result=await c.query(`SELECT * FROM (
    SELECT 'column' AS kind,a.attname AS name,format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull::text||':'||coalesce(pg_get_expr(d.adbin,d.adrelid),'') AS definition
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid='public.bnms_dd_beta_invoice_link'::regclass AND a.attnum>0 AND NOT a.attisdropped
    UNION ALL SELECT 'table',relname,jsonb_build_object('rls',relrowsecurity,'force',relforcerowsecurity,'acl',relacl)::text
      FROM pg_class WHERE oid='public.bnms_dd_beta_invoice_link'::regclass
    UNION ALL SELECT 'constraint',conname,pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.bnms_dd_beta_invoice_link'::regclass
    UNION ALL SELECT 'index',indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='bnms_dd_beta_invoice_link'
    UNION ALL SELECT 'function',proname,pg_get_functiondef(oid) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('bnms_dd_beta_invoice_owner_guard','bnms_dd_reject_history_mutation')
    UNION ALL SELECT 'trigger',tgname,tgenabled::text||':'||pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid='public.bnms_dd_beta_invoice_link'::regclass AND NOT tgisinternal
    UNION ALL SELECT 'policy',policyname,row_to_json(p)::text FROM pg_policies p WHERE schemaname='public' AND tablename='bnms_dd_beta_invoice_link'
    ) evidence ORDER BY kind,name`);
  return hash(result.rows);
}
export async function applyInvoiceSchema(c,sql,reviewSha256) {
  const digest=sqlHash(sql);
  if(digest!==reviewSha256) fail('Exact reviewed migration SHA required');
  await c.query('BEGIN');
  try {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('bnms-dd-beta-invoice-reconciliation'))");
    const ready=(await c.query("SELECT to_regclass('public.bnms_dd_beta_invoice_link') IS NOT NULL AS ready")).rows[0].ready;
    if(ready) {
      await verifyInvoiceSchema(c,digest);
      await c.query('ROLLBACK');
      return {mode:'schema_replay',hash:digest,writes:0};
    }
    const partial=(await c.query("SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='bnms_dd_beta_invoice_owner_guard'")).rows;
    if(partial.length) fail('Partial invoice schema exists; review required');
    await c.query(sql);
    const revision=JSON.stringify({sqlSha256:digest,catalogSha256:await invoiceSchemaCatalogHash(c)});
    await c.query(`COMMENT ON TABLE public.bnms_dd_beta_invoice_link IS '${revision}'`);
    await c.query('COMMIT');
    return {mode:'schema_applied',hash:digest};
  }catch(e){await c.query('ROLLBACK');throw e;}
}
export async function verifyInvoiceSchema(c,expectedSqlHash) {
  const text=(await c.query("SELECT obj_description('public.bnms_dd_beta_invoice_link'::regclass,'pg_class') AS revision")).rows[0]?.revision;
  let revision;try{revision=JSON.parse(text);}catch{fail('Invoice schema revision missing');}
  if(!revision||revision.sqlSha256!==expectedSqlHash||revision.catalogSha256!==await invoiceSchemaCatalogHash(c)) fail('Invoice schema hash/catalog drift');
}

// Shared alpha/beta completion gate. Full set equality, not merely row counts.
export function assertHistoricalInvoicesComplete(history,links) {
  if(!Array.isArray(history)||!history.length||!Array.isArray(links)) fail('Historical invoices required before import completion');
  for(const key of ['history_id','provider_payment_id','xero_invoice_id','xero_payment_id']) {
    if(links.some(l=>!l[key])||new Set(links.map(l=>l[key])).size!==links.length) fail(`Missing or duplicate ${key}`);
  }
  if(history.length!==links.length||history.some(h=>!links.some(l=>l.history_id===h.id
    &&l.provider_payment_id===h.provider_payment_id&&l.member_id===h.member_id&&l.tenant_id===h.tenant_id))) {
    fail('Historical invoice coverage incomplete; provider-only import cannot be complete');
  }
}

export function invoiceManifest(e) {
  if(e?.tenantId!==TENANT_ID||e.xeroTenantId!==XERO_TENANT_ID||e.rows?.length!==221
    ||new Set(e.rows.map(r=>r.member_id)).size!==10) fail('Pinned ten-member beta scope required');
  return {version:1,batchHash:BATCH_HASH,tenantId:TENANT_ID,xeroTenantId:XERO_TENANT_ID,
    historicalInvoiceCoverage:'complete',collectionHeld:true,links:reconcileHistoricalInvoices(e)};
}

// Shared financial/ownership validation. Beta keeps its pinned batch gate above;
// alpha supplies its complete per-member historical set, never an equal-count subset.
export function reconcileHistoricalInvoices(e) {
  if(e?.tenantId!==TENANT_ID||e.xeroTenantId!==XERO_TENANT_ID) fail('Pinned historical tenant required');
  const links=e.rows.map(r=>{
    if(r.tenant_id!==TENANT_ID||r.member_id==='33e5d54d-162e-436d-9bff-ec6676d198f9'||!uuid(r.id)||!uuid(r.member_id)) fail('Historical ownership mismatch');
    const owners=e.provider.filter(p=>p.mandate.id===r.mandate_id&&p.customer.id===r.customer_id
      &&p.mandate.links?.customer===r.customer_id&&p.mandate.links?.creditor==='CR0000B50W1Y2R');
    if(owners.length!==1) fail('Live mandate/customer ownership ambiguous');
    const owner=owners[0],payments=owner.payments.filter(p=>p.id===r.provider_payment_id);
    if(payments.length!==1) fail('Live provider payment missing or ambiguous');
    const p=payments[0],saved=r.evidence;
    if(p.status!=='paid_out'||p.links?.mandate!==r.mandate_id||p.links?.creditor!=='CR0000B50W1Y2R'
      ||p.amount_refunded!==0||p.currency!=='GBP'||r.currency!=='GBP'||p.amount!==r.amount_minor
      ||!Number.isSafeInteger(p.amount)||p.amount<=0||p.charge_date!==day(r.charge_date)
      ||saved.id!==p.id||saved.amount!==p.amount||saved.currency!==p.currency
      ||saved.charge_date!==p.charge_date||saved.links?.mandate!==p.links.mandate
      ||saved.metadata?.['Invoice number']!==p.metadata?.['Invoice number']) fail('Provider evidence drift/refund');
    // Duplicate invoice numbers exist in Xero: require exact provider-payment
    // reference as well as the number; do not select by name or number alone.
    const candidates=e.invoices.filter(i=>i.InvoiceNumber===p.metadata?.['Invoice number']
      &&i.Payments?.some(x=>x.Reference===p.id));
    if(candidates.length!==1) fail('Exact invoice/payment identity missing or ambiguous');
    const i=candidates[0],xp=i.Payments[0];
    const contacts=e.contacts.filter(c=>c.ContactID===i.Contact?.ContactID);
    if(contacts.length!==1) fail('Verified Xero contact required');
    const contact=contacts[0];
    if(!norm(contact.EmailAddress)||![norm(r.email),norm(owner.customer.email)].includes(norm(contact.EmailAddress))
      ||contact.ContactStatus!=='ACTIVE'||!uuid(contact.ContactID)) fail('Xero contact ownership mismatch');
    if(i.Type!=='ACCREC'||i.Status!=='PAID'||i.CurrencyCode!=='GBP'
      ||minor(i.Total)!==p.amount||minor(i.AmountPaid)!==p.amount||minor(i.AmountDue)!==0
      ||(Object.hasOwn(i,'AmountCredited')&&minor(i.AmountCredited)!==0)
      ||i.CreditNotes?.length||i.Prepayments?.length||i.Overpayments?.length
      ||i.Payments.length!==1||xp.Reference!==p.id||minor(xp.Amount)!==p.amount
      ||i.DateString?.slice(0,7)!==p.charge_date.slice(0,7)
      ||!uuid(i.InvoiceID)||!uuid(xp.PaymentID)||!i.InvoiceNumber
      ||!i.LineItems?.length||i.LineItems.some(l=>!['200','201'].includes(l.AccountCode))) fail('Invoice financial/period evidence conflict');
    const evidence={historicalEvidenceSha256:hash(saved),providerPayment:p,
      mandate:owner.mandate,customer:owner.customer,contact,invoice:i};
    return {history_id:r.id,tenant_id:TENANT_ID,member_id:r.member_id,
      provider_payment_id:p.id,xero_tenant_id:XERO_TENANT_ID,xero_contact_id:contact.ContactID,
      xero_invoice_id:i.InvoiceID,xero_invoice_number:i.InvoiceNumber,xero_payment_id:xp.PaymentID,
      evidence_sha256:hash(evidence),evidence};
  }).sort((a,b)=>a.history_id.localeCompare(b.history_id));
  assertHistoricalInvoicesComplete(e.rows,links);
  // One verified contact must not be claimed by two members.
  for(const l of links) if(links.some(x=>x.xero_contact_id===l.xero_contact_id&&x.member_id!==l.member_id)) fail('Cross-member contact collision');
  return links;
}

export async function importInvoiceLinks(c,manifest,{apply=false,reviewSha256,evidence,schemaSha256}={}) {
  const digest=hash(manifest);
  if(apply&&reviewSha256!==digest) fail('Exact reviewed manifest hash required');
  // Reconstruct and validate rather than trust hand-authored links.
  if(!evidence||hash(invoiceManifest(evidence))!==digest) fail('Validated full reconciliation evidence required');
  await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('bnms-dd-beta-invoice-reconciliation'))");
    const history=(await c.query(`SELECT h.*,a.mandate_id,a.customer_id,m.email FROM bnms_dd_beta_provider_history h
      JOIN bnms_dd_beta_adoption a ON a.id=h.adoption_id JOIN bnms_dd_beta_batch b ON b.id=a.batch_id
      JOIN member m ON m.id=h.member_id AND m.tenant_id=h.tenant_id
      WHERE b.evidence_sha256=$1 FOR SHARE OF h,a,b,m`,[BATCH_HASH])).rows;
    assertHistoricalInvoicesComplete(history,manifest.links);
    const heldSnapshot=async()=> (await c.query(`SELECT a.member_id,to_jsonb(p) AS plan,to_jsonb(g) AS agreement,to_jsonb(mh) AS membership,
      (SELECT count(*)::int FROM gocardless_collection_reservations r WHERE r.plan_id=p.id) AS reservations
      FROM bnms_dd_beta_adoption a JOIN bnms_dd_beta_batch b ON b.id=a.batch_id
      JOIN membership_payment_plans p ON p.id=a.plan_id
      JOIN membership_billing_agreements g ON g.id=a.agreement_id
      JOIN member_membership_history mh ON mh.id=a.history_id
      WHERE b.evidence_sha256=$1 ORDER BY a.member_id FOR SHARE OF a,p,g,mh`,[BATCH_HASH])).rows;
    const before=await heldSnapshot();
    if(before.length!==10||before.some(r=>!r.plan.collection_stopped_at||r.plan.metadata?.bnms_release_required!==true||r.reservations!==0)) fail('Beta collection hold/reservation state drift');
    for(const l of manifest.links) {
      const h=history.find(h=>h.id===l.history_id);
      const source=evidence.rows.find(r=>r.id===h.id);
      if(source.email!==h.email||source.mandate_id!==h.mandate_id||source.customer_id!==h.customer_id
        ||source.amount_minor!==h.amount_minor||source.currency!==h.currency
        ||day(source.charge_date)!==h.charge_date.toISOString().slice(0,10)) fail('Live destination ownership drift');
      if(hash(h.evidence)!==l.evidence.historicalEvidenceSha256||hash(l.evidence)!==l.evidence_sha256) fail('Persisted immutable evidence changed');
    }
    const ready=(await c.query("SELECT to_regclass('public.bnms_dd_beta_invoice_link') IS NOT NULL AS ready")).rows[0].ready;
    if(!ready) {
      if(apply) fail('Reviewed invoice link migration required');
      await c.query('ROLLBACK');
      return {mode:'dry_run',hash:digest,plannedLinks:221,migrationRequired:true,writes:0};
    }
    if(!schemaSha256) fail('Verified invoice schema SHA required');
    await verifyInvoiceSchema(c,schemaSha256);
    const guards=(await c.query(`SELECT tgname FROM pg_trigger
      WHERE tgrelid='public.bnms_dd_beta_invoice_link'::regclass AND NOT tgisinternal
      AND tgenabled IN ('O','A') AND tgname IN ('beta_invoice_owner','beta_invoice_immutable')`)).rows;
    if(guards.length!==2) fail('Invoice link ownership/immutability guards required');
    const security=(await c.query(`SELECT relrowsecurity,
      has_table_privilege('authenticated','public.bnms_dd_beta_invoice_link','SELECT') AS public_read,
      has_table_privilege('service_role','public.bnms_dd_beta_invoice_link','INSERT,UPDATE,DELETE') AS service_write
      FROM pg_class WHERE oid='public.bnms_dd_beta_invoice_link'::regclass`)).rows[0];
    if(!security?.relrowsecurity||security.public_read||security.service_write) fail('Invoice link access controls drifted');
    await c.query('LOCK TABLE bnms_dd_beta_invoice_link,member_membership_history,bnms_dd_historical_payment IN SHARE ROW EXCLUSIVE MODE');
    const prior=(await c.query('SELECT * FROM bnms_dd_beta_invoice_link WHERE tenant_id=$1',[TENANT_ID])).rows;
    if(prior.length) {
      if(prior.length!==221||manifest.links.some(l=>!prior.some(p=>p.history_id===l.history_id
        &&p.evidence_sha256===l.evidence_sha256&&p.manifest_sha256===digest&&p.xero_invoice_id===l.xero_invoice_id
        &&p.member_id===l.member_id&&p.provider_payment_id===l.provider_payment_id
        &&p.xero_payment_id===l.xero_payment_id&&hash(p.evidence)===l.evidence_sha256))) fail('Conflicting or partial reconciliation exists');
      await c.query('ROLLBACK'); return {mode:'replay',hash:digest,writes:0,linked:221};
    }
    const ids=manifest.links.map(l=>l.xero_invoice_id);
    const collisions=await c.query(`SELECT id FROM member_membership_history WHERE tenant_id=$1
      AND (xero_invoice_id::text=ANY($2::text[]) OR accounting_invoice_id::text=ANY($2::text[]))
      UNION ALL SELECT id FROM bnms_dd_historical_payment WHERE tenant_id=$1 AND xero_invoice_id::text=ANY($2::text[])`,[TENANT_ID,ids]);
    if(collisions.rows.length) fail('Existing canonical/pilot invoice association requires review');
    if(apply) for(const l of manifest.links) {
      const columns=Object.keys(l);
      await c.query(`INSERT INTO bnms_dd_beta_invoice_link (${columns.join(',')},manifest_sha256)
        VALUES (${columns.map((_,i)=>`$${i+1}`).join(',')},$${columns.length+1})`,[...Object.values(l),digest]);
    }
    if(hash(await heldSnapshot())!==hash(before)) fail('Held dynamic plan/agreement/membership state changed');
    await c.query(apply?'COMMIT':'ROLLBACK');
    return {mode:apply?'reconciled_historical_only':'dry_run',hash:digest,writes:apply?221:0,linked:apply?221:0,plannedLinks:221,collectionHeld:true};
  } catch(e) { await c.query('ROLLBACK');throw e; }
}