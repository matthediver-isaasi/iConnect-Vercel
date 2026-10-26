import { createMemberAmendmentsService, normalizeAmendmentRequest } from './memberAmendments.js';
import { calculateAmendmentTerms } from './memberAmendmentCalculation.js';
import { MEMBERSHIP_CHANGE_POLICY_DEFAULTS, validateMembershipChangePolicy,
  resolveMembershipChangeBehaviour, planMembershipChangeSettlement } from './membershipChangePolicy.js';
import { createMemberDynamicChangeAuthorityResolver } from './memberDynamicChangeAuthorityResolver.js';

const fail = message => { throw Object.assign(new Error(message), {status:422,code:'authority_evidence_required'}); };
// Production read-only adapter. Existing verified upfront evidence is admitted;
// unsupported monthly/adjusted funding is refused, never fabricated from price.
export function createMemberChangeAuthorityResolver({
  db, amendments=createMemberAmendmentsService({db}),
  monthlyResolve=createMemberDynamicChangeAuthorityResolver({db}),
}) {
  async function one(table, context, filters) {
    let query=db.from(table).select('*').eq('tenant_id',context.tenantId);
    for(const [key,value] of Object.entries(filters)) query=query.eq(key,value);
    const {data,error}=await query.maybeSingle();
    if(error) throw Object.assign(new Error('Membership authority could not be loaded'),{status:503});
    return data;
  }
  return async (context, selection) => {
    if(context.actorKind!=='admin') fail('Member initiation requires the opted-in FormBuilder flow.');
    if(selection?.action && selection.action!=='change') fail('Cancellation evidence is not yet available.');
    const request=normalizeAmendmentRequest({...selection,memberId:context.memberId,settlementChoice:'defer'});
    const sourceContext=typeof amendments.source==='function'
      ? await amendments.source(context.tenantId,context.memberId) : null;
    if(sourceContext?.current?.commitment_snapshot?.payment_frequency==='monthly') {
      return monthlyResolve(context,selection);
    }
    const preview=await amendments.preview(context.tenantId,request);
    if(!preview.canCreate || !preview.quote) fail(preview.blockers?.join(' ') || 'Purchase evidence is unavailable.');
    const q=preview.quote, source=q.sourceSnapshot;
    if(source.config_id===q.targetSnapshot.config.id && (source.band_id||null)===(q.targetSnapshot.band?.id||null)) {
      fail('Select a different membership structure or tier.');
    }
    const governing=await one('membership_tier_config',context,{id:source.config_id});
    const behaviour=resolveMembershipChangeBehaviour(source,governing);
    const policySnapshot=await one('membership_change_policy',context,{});
    const policy=validateMembershipChangePolicy(policySnapshot?.policy || {...MEMBERSHIP_CHANGE_POLICY_DEFAULTS});
    const proof=q.fundingEvidence;
    if(!proof?.sourceInvoiceId || !proof.paymentIds?.length
      || proof.paidMinor!==q.originalFullTerm.grossMinor) fail('Verified original settlement evidence is required.');
    const fundingEvidence={
      sourceRecordId:source.id,currency:q.currency,asOfDate:q.effectiveDate,complete:true,
      providerEvidence:proof,
      settledFunding:[{id:`${proof.provider}:${proof.sourceInvoiceId}`,sourceRecordId:source.id,
        currency:q.currency,state:'settled',ownerType:'member',ownerId:context.memberId,
        kind:'cash',...q.originalFullTerm}],
      pendingCollections:[],failedCollections:[],outstandingDue:{netMinor:0,vatMinor:0,grossMinor:0},
    };
    // The admitted source/target scope is explicitly twelve-month rolling.
    const anniversary=new Date(`${q.effectiveDate}T00:00:00Z`);
    const originalMonth=anniversary.getUTCMonth();
    anniversary.setUTCFullYear(anniversary.getUTCFullYear()+1);
    if(anniversary.getUTCMonth()!==originalMonth) anniversary.setUTCDate(0);
    const calculation=calculateAmendmentTerms({
      sourceRecordId:source.id,memberId:context.memberId,currency:q.currency,frequency:'upfront',
      sourcePrice:q.originalFullTerm,term:q.term,effectiveDate:q.effectiveDate,evidence:fundingEvidence,
      behaviour,targetPrice:q.targetFullTerm,
      targetTerm:{startDate:q.effectiveDate,renewalDate:anniversary.toISOString().slice(0,10)},
    });
    const settlement=planMembershipChangeSettlement({calculation,policy,issuedAt:`${q.effectiveDate}T00:00:00Z`});
    return {version:1,tenantId:context.tenantId,memberId:context.memberId,action:'change',
      request,sourceSnapshot:source,targetSnapshot:q.targetSnapshot.config,
      targetBandSnapshot:q.targetSnapshot.band||null,governingSnapshot:governing,
      pricingSnapshot:q.targetSnapshot,policySnapshot,calculation,fundingEvidence,settlement,
      executionEnabled:false};
  };
}
