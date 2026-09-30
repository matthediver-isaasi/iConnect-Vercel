// Canonical adoption only: NEVER calls a provider mutation or starts workers.
import { buildAgreementSnapshot } from '../api/_lib/gocardlessDirectDebit.js';
import { buildIdempotencyKey } from '../api/_lib/gocardless.js';
import { MEMBER_ID, TENANT_ID, MANDATE_ID, CUSTOMER_ID } from './bnms-dd-pilot.mjs';
import { STRUCTURE_ID, fingerprint } from './bnms-dd-pilot-history.mjs';
export const CUTOVER = '2026-10-01';
export const END = '2027-09-30';
export const ACCOUNTING = Object.freeze({
  version: 1, provider: 'xero', xero_tenant_id: '3d57dce6-2205-462f-abf6-9c7cbf00be23',
  bank_account_id: 'd115eacc-1fa7-476d-844e-d3d7f07f5db5', revenue_account_code: '200',
  source: 'bnms_pilot_existing_payment_evidence',
});
export const APPROVAL = Object.freeze({
  source: 'task-4533-explicit-user-approval',
  memberId: MEMBER_ID, dynamicCurrentStructurePrice: true, continueAutomatically: true,
  legacyCustomerAutomaticPaymentsDisabled: true, nominatedDay: 1,
  managementPeriodStart: CUTOVER, managementPeriodEnd: END,
  originalCommencementUnknown: true, sharedStructureUnchanged: true,
});
const fail = message => { throw new Error(message); };
export function adoptionManifest(e) {
  const c = e.config;
  if (e.member?.id !== MEMBER_ID || e.member.tenant_id !== TENANT_ID
    || e.member.is_deleted || e.member.deleted_at || e.member.membership_paused
    || ['cancelled','deleted','paused'].includes(e.member.status)) fail('Pilot member unavailable');
  if (e.classes?.length !== 1 || e.classes[0].value !== 'Full with NMC'
    || e.classes[0].field_id !== c?.structure_field_id) fail('Pilot member class conflict');
  if (c?.id !== STRUCTURE_ID || c.tenant_id !== TENANT_ID || c.is_active !== true
    || c.structure_scope_type !== 'member' || c.structure_match_value !== 'Full with NMC'
    || c.pricing_model !== 'flat' || c.currency !== 'GBP' || Number(c.dd_monthly_amount) !== 13
    || c.start_mode !== 'immediate' || c.billing_period !== 'annual'
    || c.dd_instalment_count !== 12 || !c.dd_enabled || !c.dd_auto_renew
    || c.dd_invoicing_mode !== 'per_instalment' || c.dd_activation_rule !== 'first_payment'
    || c.effective_from > CUTOVER || (c.effective_to && c.effective_to < CUTOVER)
    || e.scopeConfigCount !== 1) fail('Approved effective structure conflict');
  if (e.price?.config_id !== c.id || e.price.monthly_amount_minor !== 1300
    || e.price.currency !== 'GBP') fail('Current dynamic price conflict');
  if (e.mandate?.id !== MANDATE_ID || e.mandate.status !== 'active'
    || e.mandate.links?.customer !== CUSTOMER_ID || e.mandate.links?.creditor !== 'CR0000B50W1Y2R'
    || !/^\d{4}-\d{2}-\d{2}$/.test(e.mandate.next_possible_charge_date || '')
    || e.mandate.next_possible_charge_date > CUTOVER || e.today > CUTOVER
    || e.customer?.id !== CUSTOMER_ID) fail('Mandate ownership or October notice deadline conflict');
  if (!Array.isArray(e.subscriptions) || e.subscriptions.length
    || !Array.isArray(e.payments) || !Array.isArray(e.futureInvoices)) fail('Complete empty subscription evidence required');
  if (e.payments.some(p => p.links?.mandate !== MANDATE_ID
    || !p.charge_date || p.charge_date >= CUTOVER
    || ['pending_submission','submitted','confirmed'].includes(p.status))
    || e.futureInvoices.length) fail('Existing pending/future invoice or collection requires reconciliation');
  const dd = buildPilotSnapshot(c);
  return { version: 1, approval: APPROVAL, structure: c, dd,
    // Provider earliest date is revalidated, not a consent term: changing it
    // within the safe window must not destroy immutable replay identity.
    provider: { mandateId: MANDATE_ID, customerId: CUSTOMER_ID, creditorId: 'CR0000B50W1Y2R' },
    price: e.price, collectionReleaseRequired: true };
}
export function buildPilotSnapshot(config) {
  const snapshot = buildAgreementSnapshot({
    acceptedAt: null, billingRequestMode: 'migration_existing_mandate',
    offer: { collectionPolicy: { version: 1, end_policy: 'continue', pricing_policy: 'dynamic' },
      monthlyAmount: 13, monthlyAmountMinor: 1300, instalmentCount: 12, planTotal: 156,
      currency: 'GBP', firstCollectionRule: 'nominated_day', collectionDay: 1,
      activationRule: 'first_payment', graceDays: config.dd_grace_days,
      termsVersion: config.dd_terms_version, invoicingMode: 'per_instalment',
      monthlyPostGraceCollectionPolicy: config.monthly_post_grace_collection_policy },
    simResult: { config, membershipYear: { start: CUTOVER, end: END, label: `rolling:${CUTOVER}` },
      annualCost: Number(config.flat_cost), finalCost: null, vatRatePercent: 0, tierLabel: 'Flat Rate' },
  });
  snapshot.accounting_migration = ACCOUNTING;
  return snapshot;
}
const tables = new Set(['gocardless_customers','gocardless_mandates','membership_billing_agreements',
  'membership_payment_plans','member_membership_history','bnms_dd_pilot_adoption']);
async function insert(client, table, row) {
  if (!tables.has(table) || Object.keys(row).some(k => !/^[a-z_][a-z_0-9]*$/.test(k))) fail('Unsafe insert target');
  const keys = Object.keys(row);
  return (await client.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(',')}) RETURNING *`,
    keys.map(k => row[k]))).rows[0];
}
export async function adoptPilot(client, evidence, { apply=false, reviewSha256, verifiedDestination=false }={}) {
  const manifest = adoptionManifest(evidence), hash = fingerprint(manifest);
  if (apply && (!verifiedDestination || reviewSha256 !== hash)) fail('Exact reviewed manifest and verified destination required');
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('bnms-dd-pilot-4533'))");
    await client.query(`LOCK TABLE member, membership_tier_config, preference_field, member_preference_value,
      membership_billing_agreements, membership_payment_plans, member_membership_history,
      gocardless_customers, gocardless_mandates, gocardless_payments,
      gocardless_collection_reservations IN SHARE ROW EXCLUSIVE MODE`);
    const one = async (sql,args=[]) => (await client.query(sql,args)).rows;
    const member = await one('SELECT * FROM member WHERE id=$1 AND tenant_id=$2',[MEMBER_ID,TENANT_ID]);
    const config = await one('SELECT to_jsonb(c) AS data FROM membership_tier_config c WHERE id=$1 AND tenant_id=$2',[STRUCTURE_ID,TENANT_ID]);
    if (member.length !== 1 || config.length !== 1 || fingerprint(config[0].data) !== fingerprint(evidence.config)) fail('Destination member/structure drift');
    const classes = await one(`SELECT v.field_id,v.value FROM member_preference_value v JOIN preference_field f ON f.id=v.field_id
      WHERE v.member_id=$1 AND f.tenant_id=$2 AND f.name='member_class' AND f.entity_scope='member' AND f.is_active=true`,[MEMBER_ID,TENANT_ID]);
    const scopes=await one(`SELECT id FROM membership_tier_config WHERE tenant_id=$1 AND is_active=true AND dd_enabled=true
      AND structure_scope_type='member' AND structure_field_id=$2 AND lower(trim(structure_match_value))='full with nmc'
      AND start_mode='immediate' AND (effective_from IS NULL OR effective_from <= $3)
      AND (effective_to IS NULL OR effective_to >= $3)`,[TENANT_ID,evidence.config.structure_field_id,CUTOVER]);
    if(scopes.length!==1||scopes[0].id!==STRUCTURE_ID)fail('Current active scope is ambiguous');
    adoptionManifest({...evidence,member:member[0],classes});
    const historical = await one(`SELECT i.id,i.evidence_sha256,count(p.id)::integer AS n FROM bnms_dd_pilot_import i
      JOIN bnms_dd_historical_payment p ON p.import_id=i.id WHERE i.member_id=$1 AND i.tenant_id=$2
      GROUP BY i.id`,[MEMBER_ID,TENANT_ID]);
    if(historical.length!==1 || historical[0].n!==9
      || historical[0].evidence_sha256!=='c016597c54b30549dd0e50c5994d8d4b1d0578d5cb31437dbec2b1bb9de09c52') fail('Applied nine-period historical provenance missing');
    const schemaReady=(await one("SELECT to_regclass('public.bnms_dd_pilot_adoption') IS NOT NULL AS ready"))[0].ready;
    if(apply&&!schemaReady)fail('Reviewed pilot adoption migration required before apply');
    const prior = schemaReady ? await one('SELECT * FROM bnms_dd_pilot_adoption WHERE member_id=$1',[MEMBER_ID]) : [];
    if(prior.length) {
      if(prior[0].evidence_sha256!==hash) fail('Immutable adoption evidence differs');
      const linked=await one(`SELECT a.id FROM membership_billing_agreements a JOIN membership_payment_plans p ON p.billing_agreement_id=a.id
        JOIN member_membership_history h ON h.billing_agreement_id=a.id
        WHERE a.id=$1 AND p.id=$2 AND h.id=$3 AND a.member_id=$4 AND a.tenant_id=$5
          AND p.member_id=$4 AND p.tenant_id=$5 AND h.member_id=$4 AND h.tenant_id=$5`,
        [prior[0].agreement_id,prior[0].plan_id,prior[0].history_id,MEMBER_ID,TENANT_ID]);
      if(linked.length!==1) fail('Incomplete canonical adoption requires repair');
      await client.query('ROLLBACK'); return {mode:'replay',writes:0,hash,adoption:prior[0]};
    }
    for(const table of ['membership_billing_agreements','membership_payment_plans','member_membership_history']) {
      if((await one(`SELECT id FROM ${table} WHERE member_id=$1`,[MEMBER_ID])).length) fail(`Existing ${table} requires reconciliation`);
    }
    if((await one(`SELECT id FROM membership_billing_agreements WHERE gocardless_mandate_id=$1
      UNION ALL SELECT id FROM membership_payment_plans WHERE gocardless_mandate_id=$1`,[MANDATE_ID])).length) fail('Mandate already attached');
    if((await one(`SELECT id FROM gocardless_payments WHERE gocardless_mandate_id=$1
      AND (charge_date >= $2 OR status IN ('pending_submission','submitted','confirmed'))`,[MANDATE_ID,CUTOVER])).length) fail('Canonical collection conflict');
    const customers=await one('SELECT * FROM gocardless_customers WHERE gocardless_customer_id=$1',[CUSTOMER_ID]);
    const mandates=await one('SELECT * FROM gocardless_mandates WHERE gocardless_mandate_id=$1',[MANDATE_ID]);
    if(customers.some(r=>r.tenant_id!==TENANT_ID||r.member_id!==MEMBER_ID||r.organization_id||r.environment!=='live')
      || mandates.some(r=>r.tenant_id!==TENANT_ID||r.gocardless_customer_id!==CUSTOMER_ID||r.environment!=='live'||r.status!=='active')) fail('Existing provider mirror ownership conflict');
    if(!apply){await client.query('ROLLBACK');return {mode:'dry_run',writes:0,hash,manifest,migrationRequired:!schemaReady,collectionReleaseRequired:true};}
    let writes=0;
    if(!customers.length){await insert(client,'gocardless_customers',{tenant_id:TENANT_ID,member_id:MEMBER_ID,gocardless_customer_id:CUSTOMER_ID,environment:'live',metadata:{source:'bnms_pilot_adoption'}});writes++;}
    if(!mandates.length){await insert(client,'gocardless_mandates',{tenant_id:TENANT_ID,gocardless_customer_id:CUSTOMER_ID,gocardless_mandate_id:MANDATE_ID,status:'active',environment:'live',next_possible_charge_date:evidence.mandate.next_possible_charge_date,metadata:{source:'bnms_pilot_adoption'}});writes++;}
    const dd=manifest.dd, term=dd.commitment;
    // Provider evidence already proves an active existing mandate. This is a
    // first-payment wait, not new mandate setup. The stop/release fences below
    // still prohibit collection; history remains unpaid and unactivated.
    const agreement=await insert(client,'membership_billing_agreements',{...term,tenant_id:TENANT_ID,member_id:MEMBER_ID,
      agreement_type:'member',provider:'gocardless',gocardless_customer_id:CUSTOMER_ID,gocardless_mandate_id:MANDATE_ID,
      status:'first_payment_pending',environment:'live',needs_attention:true,attention_reason:'BNMS pilot imported: separate reviewed collection release required',
      idempotency_key:buildIdempotencyKey('bnms-pilot-adoption',TENANT_ID,MEMBER_ID,CUTOVER),
      metadata:{dd,commitment:term,bnms_pilot_approval:APPROVAL}});
    const plan=await insert(client,'membership_payment_plans',{tenant_id:TENANT_ID,member_id:MEMBER_ID,billing_agreement_id:agreement.id,
      provider:'gocardless',gocardless_mandate_id:MANDATE_ID,amount_minor:1300,currency:'GBP',interval_unit:'monthly',
      day_of_month:1,status:'first_payment_pending',membership_year:dd.membership_year,start_date:CUTOVER,instalments_total:12,
      environment:'live',dynamic_next_collection_date:CUTOVER,
      // Existing domain/RPC lifecycle guard: import cannot authorize collection.
      collection_stopped_at:new Date().toISOString(),
      idempotency_key:buildIdempotencyKey('dd-dynamic-plan',TENANT_ID,agreement.id,term.term_key),
      metadata:{collection_mode:'dynamic',dynamic_first_date:CUTOVER,agreement_id:agreement.id,bnms_release_required:true}});
    const history=await insert(client,'member_membership_history',{...term,tenant_id:TENANT_ID,member_id:MEMBER_ID,
      membership_year:dd.membership_year,config_id:STRUCTURE_ID,tier_label:'Flat Rate',currency:'GBP',
      annual_cost:term.commitment_snapshot.amounts.annual_cost,final_cost:null,vat_amount:null,total_with_vat:null,
      billing_period:'monthly_direct_debit',payment_method:'direct_debit',status:'pending_payment_setup',
      payment_status:'unpaid',billing_agreement_id:agreement.id,
      notes:'BNMS migration: managed billing period only, not original membership commencement. Dynamic monthly current-structure price; separate collection release required.'});
    const adoption=await insert(client,'bnms_dd_pilot_adoption',{tenant_id:TENANT_ID,member_id:MEMBER_ID,historical_import_id:historical[0].id,
      agreement_id:agreement.id,plan_id:plan.id,history_id:history.id,evidence_sha256:hash,evidence:manifest});
    await client.query('COMMIT');
    return {mode:'adopted_collection_held',writes:writes+4,hash,adoption,collectionReleaseRequired:true,providerWrites:0};
  }catch(error){await client.query('ROLLBACK');throw error;}
}