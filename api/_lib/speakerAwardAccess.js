import { supabase } from './database.js';
import { getTenantContext, hasAdminAccess } from './tenantContext.js';
import { getSessionMember } from './session.js';
import { makeFeatureAccessChecker } from './memberFeatureAccess.js';

export const speakerAwardUuid = value => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function privateSpeakerResponse(res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Vary', 'Cookie');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

async function roleAllows(db, tenantId, roleId, memberExclusions, features) {
  if (!roleId) return false;
  const { data, error } = await db.from('role').select('excluded_features')
    .eq('id', roleId).eq('tenant_id', tenantId).maybeSingle();
  if (error || !data || (data.excluded_features != null && !Array.isArray(data.excluded_features))) return false;
  const checker = makeFeatureAccessChecker([
    ...(data.excluded_features || []), ...(Array.isArray(memberExclusions) ? memberExclusions : []),
  ]);
  return features.some(feature => checker.canAccessFeature(feature));
}

export async function speakerAwardStaff(req, dependencies = {}, { templates = false } = {}) {
  const db = dependencies.db || supabase;
  const ctx = await (dependencies.tenantContext || getTenantContext)(req);
  if (!ctx?.isAuthenticated || !ctx.tenantId) return null;
  if (await (dependencies.adminAccess || hasAdminAccess)(ctx)) return { tenantId: ctx.tenantId };
  const features = templates
    ? ['events.speakers', 'events.browse-events.create']
    : ['events.speakers'];
  return await roleAllows(db, ctx.tenantId, ctx.roleId, ctx.memberExcludedFeatures, features)
    ? { tenantId: ctx.tenantId } : null;
}

export async function speakerAwardMember(req, dependencies = {}) {
  const db = dependencies.db || supabase;
  const member = await (dependencies.sessionMember || getSessionMember)(req);
  const tenantId = member?.tenant_id || member?.organization?.tenant_id;
  if (!member?.id || !tenantId) return null;
  return await roleAllows(db, tenantId, member.role_id, member.member_excluded_features, ['cpd.member_cpd'])
    ? { tenantId, memberId: member.id } : null;
}

// Staff member-record access mirrors the independent administration path used
// by non-speaker CPD certificates, not the selected member's own role.
export async function speakerAwardMemberRecord(req, dependencies = {}) {
  const db = dependencies.db || supabase;
  const ctx = await (dependencies.tenantContext || getTenantContext)(req);
  if (!ctx?.isAuthenticated || !ctx.tenantId || ctx.tenantMismatch
    || !await (dependencies.adminAccess || hasAdminAccess)(ctx)) return null;
  const memberId = req.query?.memberId;
  if (!speakerAwardUuid(memberId)) return null;
  const { data, error } = await db.from('member').select('id')
    .eq('tenant_id', ctx.tenantId).eq('id', memberId).maybeSingle();
  if (error) throw error;
  return data ? { tenantId: ctx.tenantId, memberId } : null;
}