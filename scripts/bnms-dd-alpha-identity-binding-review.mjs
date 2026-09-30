// Read-only prerequisite for the isolated Alpha operator exception.
// No release, provider access, credentials, or financial mutations.
import {isAdminMembership} from '../api/auth/_lib/adminPasswordMembership.js';
import {TENANT_ID,hash} from './bnms-dd-beta-invoices.mjs';
import {ALPHA_MANIFEST_SHA256} from './bnms-dd-alpha-release.mjs';

const normalize=value=>String(value||'').trim().toLowerCase();

export function reviewNewAlphaIdentityBindings(cached,current,bindings){
  if(cached?.tenantId!==TENANT_ID||cached.manifestSha256!==ALPHA_MANIFEST_SHA256
    ||hash(cached.manifest)!==ALPHA_MANIFEST_SHA256
    ||cached.members?.length!==249||current.length!==249
    ||new Set(current.map(m=>m.id)).size!==249){
    throw Error('Exact immutable Alpha identity review scope required');
  }
  const source=new Map(cached.manifest.members.map(m=>[m.identity.memberId,m.identity]));
  const previous=new Map(cached.state.member.map(m=>[m.id,m]));
  return current.flatMap(member=>{
    const old=previous.get(member.id),identity=source.get(member.id);
    if(!old||!identity||member.tenant_id!==TENANT_ID)
      throw Error('Alpha current identity scope/tenant mismatch');
    if(old.identity_id===member.identity_id)return [];
    return [reviewIdentityEnrichment({member,previous:old,source:identity,
      binding:bindings.find(b=>b.member_id===member.id)})];
  });
}

export function reviewIdentityEnrichment({member,previous,source,binding}){
  const blockers=[];
  const warnings=[];
  if(previous.identity_id||!member.identity_id)blockers.push('existing_binding_changed_or_removed');
  if(member.tenant_id!==TENANT_ID||member.id!==source.memberId||previous.id!==member.id)
    blockers.push('member_scope_mismatch');
  if(!normalize(member.email)||normalize(member.email)!==normalize(source.email)
    ||normalize(previous.email)!==normalize(source.email)
    ||normalize(binding?.identity_email)!==normalize(source.email))
    blockers.push('identity_source_email_mismatch');
  if(binding?.member_id!==member.id||binding?.identity_id!==member.identity_id
    ||binding?.email_identity_count!==1||binding?.owner_count!==1)
    blockers.push('identity_ownership_not_unique');
  const memberships=binding?.memberships;
  if(memberships?.length!==1||memberships[0].member_id!==member.id
    ||memberships[0].identity_id!==member.identity_id||memberships[0].tenant_id!==TENANT_ID
    ||memberships[0].membership_type!=='member'||memberships[0].status!=='active')
    blockers.push('tenant_member_binding_mismatch');
  // Separate security finding, explicitly retained per operator instruction.
  // It neither changes payer identity nor authorizes this tool to change roles.
  if(memberships?.some(isAdminMembership))
    warnings.push('new_binding_has_application_admin_authority');
  return {memberId:member.id,previousIdentityId:previous.identity_id??null,
    currentIdentityId:member.identity_id,sourceEmailSha256:hash(normalize(source.email)),
    binding,blockers,warnings,verifiedOrdinaryProfileEnrichment:blockers.length===0,
    providerOwnershipRevalidated:false};
}

export async function readAlphaIdentityBindings(c,ids){
  const current=(await c.query(`SELECT id,tenant_id,email,identity_id FROM member
    WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id`,[TENANT_ID,ids])).rows;
  // Deliberate field allowlist: never materialize password hashes/reset tokens.
  const bindings=(await c.query(`SELECT m.id member_id,m.identity_id,i.email identity_email,
    to_jsonb(i.created_at) identity_created_at,
    (SELECT count(*)::int FROM tenant_identity z WHERE lower(trim(z.email))=lower(trim(m.email))) email_identity_count,
    (SELECT count(*)::int FROM member z WHERE z.tenant_id=m.tenant_id
      AND z.identity_id::text=m.identity_id::text) owner_count,
    (SELECT jsonb_agg(jsonb_build_object('id',t.id,'member_id',t.member_id,'tenant_id',t.tenant_id,
      'identity_id',t.identity_id,'role',t.role,'status',t.status,'membership_type',t.membership_type,
      'created_at',t.created_at,'updated_at',t.updated_at) ORDER BY t.id)
      FROM tenant_membership t WHERE t.identity_id::text=m.identity_id::text
      AND t.tenant_id::text=m.tenant_id::text) memberships
    FROM member m LEFT JOIN tenant_identity i ON i.id::text=m.identity_id::text
    WHERE m.tenant_id=$1 AND m.id=ANY($2::uuid[]) ORDER BY m.id`,[TENANT_ID,ids])).rows;
  return {current,bindings};
}