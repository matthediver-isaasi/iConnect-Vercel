import { MEMBER_ID,TENANT_ID,MANDATE_ID,CUSTOMER_ID } from './bnms-dd-pilot.mjs';
import { ACCOUNTING,CUTOVER,adoptionManifest } from './bnms-dd-pilot-adoption.mjs';
import { fingerprint } from './bnms-dd-pilot-history.mjs';
const fail=m=>{throw Error(m);};
export function releaseManifest(e,adoption,proof,accounts){
  const m=adoptionManifest(e);
  if(adoption.member_id!==MEMBER_ID||adoption.tenant_id!==TENANT_ID
    ||adoption.evidence_sha256!==fingerprint(m)||fingerprint(adoption.evidence)!==fingerprint(m))
    fail('Held adoption differs from fresh approved evidence');
  if(accounts?.bank?.AccountID!==ACCOUNTING.bank_account_id||accounts.bank.Type!=='BANK'
    ||accounts.bank.Status!=='ACTIVE'||accounts.bank.CurrencyCode!=='GBP'
    ||accounts.revenue?.AccountID!=='8f87b705-a870-4c5e-b46a-74a5a4de73ce'
    ||accounts.revenue.Code!=='200'||accounts.revenue.Status!=='ACTIVE'
    ||accounts.revenue.Type!=='REVENUE')fail('Verified Xero bank/revenue identities are not active');
  if(!proof?.sourceHashes||!proof.deploymentId||!proof.commit)fail('Verified production proof required');
  return {version:2,memberId:MEMBER_ID,tenantId:TENANT_ID,adoptionId:adoption.id,
    adoptionHash:adoption.evidence_sha256,production:proof,accounting:ACCOUNTING,
    firstManagedDate:CUTOVER,firstManagedAmountMinor:1300,collectionMode:'dynamic',
    processingNotBefore:'2026-09-30T23:00:00Z',processingTimeZone:'Europe/London',
    purpose:'Arm held management plan; worker processes from October 1 London midnight using provider-authoritative date within existing seven-day safety window'};
}
export async function releasePilot(client,{evidence,proof,accounts,apply=false,reviewSha256,verifiedDestination=false}={}){
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try{
    await client.query("SELECT pg_advisory_xact_lock(hashtext('bnms-dd-pilot-4533'))");
    await client.query(`LOCK TABLE member,membership_tier_config,preference_field,member_preference_value,membership_billing_agreements,
      membership_payment_plans,member_membership_history,gocardless_payments,
      gocardless_collection_reservations,bnms_dd_pilot_adoption IN SHARE ROW EXCLUSIVE MODE`);
    const rows=async(sql,args=[])=>(await client.query(sql,args)).rows;
    const a=(await rows('SELECT * FROM bnms_dd_pilot_adoption WHERE member_id=$1 AND tenant_id=$2 FOR UPDATE',[MEMBER_ID,TENANT_ID]))[0];
    if(!a)fail('Pinned HELD adoption must be applied before release');
    const linked=await rows(`SELECT a.id,a.metadata,a.status,p.status AS plan_status,p.collection_stopped_at,
      p.gocardless_subscription_id,p.dynamic_next_collection_date::text,p.start_date::text,
      p.metadata AS plan_metadata,p.day_of_month,p.amount_minor,p.currency,h.payment_status,h.status AS membership_status
      FROM membership_billing_agreements a JOIN membership_payment_plans p ON p.billing_agreement_id=a.id
      JOIN member_membership_history h ON h.billing_agreement_id=a.id
      WHERE a.id=$1 AND p.id=$2 AND h.id=$3 AND a.member_id=$4 AND a.tenant_id=$5
      AND p.member_id=$4 AND p.tenant_id=$5 AND h.member_id=$4 AND h.tenant_id=$5
      AND a.gocardless_mandate_id=$6 AND p.gocardless_mandate_id=$6 AND a.gocardless_customer_id=$7
      AND a.environment='live' AND p.environment='live' AND a.provider='gocardless' AND p.provider='gocardless'`,
      [a.agreement_id,a.plan_id,a.history_id,MEMBER_ID,TENANT_ID,MANDATE_ID,CUSTOMER_ID]);
    if(linked.length!==1)fail('Release owner/provider linkage mismatch');
    const schemaReady=(await rows("SELECT to_regclass('public.bnms_dd_pilot_release') IS NOT NULL AS ready"))[0].ready;
    if(schemaReady){
      const guard=await rows(`SELECT t.oid FROM pg_trigger t WHERE t.tgrelid='gocardless_collection_reservations'::regclass
        AND t.tgname='bnms_dd_initial_reservation_guard' AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal
        AND pg_get_functiondef(t.tgfoid) LIKE '%BNMS pilot processing-not-before October 1 Europe/London%'`);
      if(guard.length!==1)fail('Pilot processing-start database guard must be enabled; apply separately reviewed processing-start migration');
    }
    const prior=schemaReady?(await rows('SELECT * FROM bnms_dd_pilot_release WHERE adoption_id=$1',[a.id]))[0]:null;
    if(prior){
      if(prior.member_id!==MEMBER_ID||prior.tenant_id!==TENANT_ID)fail('Release replay identity mismatch');
      if(apply&&(!verifiedDestination||reviewSha256!==prior.evidence_sha256))fail('Reviewed release hash required on replay');
      await client.query('ROLLBACK');
      return {mode:'release_replay',writes:0,hash:prior.evidence_sha256,release:prior,
        readinessRevalidated:false,providerWrites:0};
    }
    const manifest=releaseManifest(evidence,a,proof,accounts),hash=fingerprint(manifest),r=linked[0];
    if(r.gocardless_subscription_id||!r.collection_stopped_at||r.day_of_month!==1||r.amount_minor!==1300||r.currency!=='GBP'
      ||r.start_date!==CUTOVER||r.dynamic_next_collection_date!==CUTOVER||r.plan_metadata?.dynamic_first_date!==CUTOVER
      ||r.plan_metadata?.collection_mode!=='dynamic'||!r.plan_metadata.bnms_release_required
      ||r.payment_status!=='unpaid'||r.membership_status!=='pending_payment_setup'
      ||!['payment_setup_required','mandate_pending','first_payment_pending'].includes(r.status)
      ||!['payment_setup_required','mandate_pending','first_payment_pending'].includes(r.plan_status)
      ||fingerprint(r.metadata.dd)!==fingerprint(a.evidence.dd))fail('Canonical HELD records drifted');
    const member=(await rows('SELECT to_jsonb(m) AS data FROM member m WHERE id=$1 AND tenant_id=$2',[MEMBER_ID,TENANT_ID]))[0]?.data;
    const classes=await rows(`SELECT v.field_id,v.value FROM member_preference_value v JOIN preference_field f ON f.id=v.field_id
      WHERE v.member_id=$1 AND f.tenant_id=$2 AND f.name='member_class' AND f.entity_scope='member' AND f.is_active=true`,[MEMBER_ID,TENANT_ID]);
    adoptionManifest({...evidence,member,classes});
    const config=(await rows('SELECT to_jsonb(c) AS data FROM membership_tier_config c WHERE id=$1 AND tenant_id=$2',[evidence.config.id,TENANT_ID]))[0]?.data;
    if(fingerprint(config)!==fingerprint(evidence.config))fail('Current structure drift');
    if((await rows(`SELECT id FROM gocardless_collection_reservations WHERE plan_id=$1
      UNION ALL SELECT id FROM gocardless_payments WHERE gocardless_mandate_id=$2
      AND (charge_date >= $3 OR status IN ('pending_submission','submitted','confirmed'))`,[a.plan_id,MANDATE_ID,CUTOVER])).length)
      fail('Existing reservation/payment requires reconciliation before release');
    if(!apply){await client.query('ROLLBACK');return {mode:'release_dry_run',writes:0,hash,manifest,migrationRequired:!schemaReady};}
    if(!verifiedDestination||reviewSha256!==hash||!schemaReady)fail('Verified destination, reviewed hash and release migration required');
    const inserted=await rows(`INSERT INTO bnms_dd_pilot_release(adoption_id,tenant_id,member_id,evidence_sha256,evidence)
      VALUES($1,$2,$3,$4,$5) RETURNING *`,[a.id,TENANT_ID,MEMBER_ID,hash,manifest]);
    // Fresh adoptionManifest evidence above confirms the existing mandate.
    // Do not regress it to mandate_pending or claim first-payment settlement.
    const agreement=await client.query(`UPDATE membership_billing_agreements SET status='first_payment_pending',
      needs_attention=false,attention_reason=NULL,updated_at=now() WHERE id=$1 AND tenant_id=$2 AND member_id=$3`,
      [a.agreement_id,TENANT_ID,MEMBER_ID]);
    const plan=await client.query(`UPDATE membership_payment_plans SET status='first_payment_pending',collection_stopped_at=NULL,
      metadata=jsonb_set(metadata,'{bnms_release_required}','false'),updated_at=now()
      WHERE id=$1 AND tenant_id=$2 AND member_id=$3 AND collection_stopped_at IS NOT NULL`,
      [a.plan_id,TENANT_ID,MEMBER_ID]);
    if(agreement.rowCount!==1||plan.rowCount!==1)fail('Concurrent release conflict');
    await client.query('COMMIT');
    return {mode:'released_to_dynamic_worker',writes:3,hash,release:inserted[0],providerWrites:0,
      paymentScheduled:false,settlementVerified:false};
  }catch(e){await client.query('ROLLBACK');throw e;}
}