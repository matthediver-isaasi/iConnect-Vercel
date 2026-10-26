import { monthlyAmendmentFingerprint } from './memberAmendmentMonthly.js';
import { normalizeAmendmentRequest } from './memberAmendments.js';

const fail = message => { throw Object.assign(new Error(message), { status: 409, code: 'change_authority_conflict' }); };
// Shared by future admin/member entry points. resolve must authorize the actor,
// load purchase/target/policy and reconcile provider evidence server-side.
// Never use a browser quote as the resolve result.
export function createMemberChangeAuthorityService({ db, resolve }) {
  if (typeof resolve !== 'function') throw new Error('Trusted change resolver required');
  function checkActor(context) {
    if(!context.actorId || !context.tenantId || !context.memberId
      || !['admin','member'].includes(context.actorKind)
      || (context.actorKind==='member' && context.actorId!==context.memberId)) fail('Incomplete or foreign membership change evidence');
  }
  function checkKey(key,fingerprint) {
    if(typeof key!=='string' || !/^[A-Za-z0-9_.:-]{8,128}$/.test(key)
      || typeof fingerprint!=='string' || !/^[a-f0-9]{64}$/.test(fingerprint)) fail('A valid confirmation key and preview fingerprint are required');
  }
  async function recover(context,{key,fingerprint}) {
    checkActor(context);checkKey(key,fingerprint);
    const {data,error}=await db.from('member_change_authority').select('*')
      .eq('tenant_id',context.tenantId).eq('member_id',context.memberId).eq('request_key',key).maybeSingle();
    if(error) throw Object.assign(new Error('Confirmation recovery is unavailable; do not submit a new request key.'),{status:503,code:'authority_recovery_unavailable'});
    if(!data) return null;
    if(data.tenant_id!==context.tenantId || data.member_id!==context.memberId
      || data.actor_id!==context.actorId || data.actor_kind!==context.actorKind
      || monthlyAmendmentFingerprint(data.authority)!==fingerprint) fail('Confirmation key belongs to different evidence or actor');
    // A recovered confirmation is NOT proof of approval/settlement/application.
    return data;
  }
  async function preview(context, selection) {
    checkActor(context);
    const authority = await resolve(context, selection);
    if (!context.actorId || !['admin','member'].includes(context.actorKind)
      || (context.actorKind === 'member' && context.actorId !== context.memberId)
      || authority.tenantId !== context.tenantId || authority.memberId !== context.memberId
      || authority.version !== 1 || !authority.sourceSnapshot?.id
      || authority.calculation?.sourceRecordId !== authority.sourceSnapshot.id
      || authority.calculation?.entitlementApplied !== false
      || authority.calculation?.settlementStatus !== 'not_started'
      || authority.fundingEvidence?.complete !== true
      || authority.fundingEvidence?.sourceRecordId !== authority.sourceSnapshot.id
      || !authority.settlement) fail('Incomplete or foreign membership change evidence');
    return { authority, fingerprint: monthlyAmendmentFingerprint(authority) };
  }
  async function confirm(context, { selection, fingerprint, key }) {
    const existing=await recover(context,{key,fingerprint});
    if(existing) {
      const request=normalizeAmendmentRequest({...selection,memberId:context.memberId,settlementChoice:'defer'});
      if(selection?.action && selection.action!==existing.authority.action) fail('Confirmation key belongs to a different action');
      if(monthlyAmendmentFingerprint(request)!==monthlyAmendmentFingerprint(existing.authority.request)) fail('Confirmation key belongs to a different selection');
      return existing;
    }
    // A fresh provider/database resolution must match the displayed evidence.
    const fresh = await preview(context, selection);
    if (fresh.fingerprint !== fingerprint) fail('Membership or payment evidence changed; preview again');
    const { data, error } = await db.rpc('confirm_member_change_authority', {
      p_tenant_id: context.tenantId, p_member_id: context.memberId,
      p_actor_id: context.actorId, p_actor_kind: context.actorKind,
      p_key: key, p_authority: fresh.authority,
    });
    if (error) fail('Could not confirm the change; refresh its evidence before retrying');
    return data;
  }
  return { preview, confirm, recover };
}
