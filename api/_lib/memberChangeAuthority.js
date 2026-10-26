import { monthlyAmendmentFingerprint } from './memberAmendmentMonthly.js';

const fail = message => { throw Object.assign(new Error(message), { status: 409, code: 'change_authority_conflict' }); };
// Shared by future admin/member entry points. resolve must authorize the actor,
// load purchase/target/policy and reconcile provider evidence server-side.
// Never use a browser quote as the resolve result.
export function createMemberChangeAuthorityService({ db, resolve }) {
  if (typeof resolve !== 'function') throw new Error('Trusted change resolver required');
  async function preview(context, selection) {
    if(!context.actorId || !['admin','member'].includes(context.actorKind)
      || (context.actorKind==='member' && context.actorId!==context.memberId)) fail('Incomplete or foreign membership change evidence');
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
    if(typeof key!=='string' || !/^[A-Za-z0-9_.:-]{8,128}$/.test(key)
      || typeof fingerprint!=='string' || !/^[a-f0-9]{64}$/.test(fingerprint)) fail('A valid confirmation key and preview fingerprint are required');
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
  return { preview, confirm };
}
