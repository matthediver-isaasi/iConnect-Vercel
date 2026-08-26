import { supabase } from '../../../_lib/database.js';
import { getTenantContext } from '../../../_lib/tenantContext.js';
import { checkBadgeWriteAccess, checkMemberBadgeTargetAccess } from '../../../_lib/badgeAccess.js';
import { awardSourceLabel, resolveBadgeActor } from '../../../_lib/memberBadgeAttribution.js';

async function loadScopedMember(tenantId, memberId) {
  return supabase
    .from('member')
    .select('id')
    .eq('id', memberId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
}

async function listMemberBadges(tenantId, memberId) {
  const { data, error } = await supabase
    .from('member_badge')
    .select('id, badge_id, awarded_at, source, source_ref, created_by, awarded_by_type, awarded_by_id, awarded_by_label, revoked_at, revoked_by_type, revoked_by_id, revoked_by_label, badge:badge_id(id, name, description, image_url, is_active)')
    .eq('tenant_id', tenantId)
    .eq('member_id', memberId)
    .order('awarded_at', { ascending: false });
  if (error) throw error;
  return (data || []).map((row) => ({
    ...row,
    status: row.revoked_at ? 'revoked' : 'active',
    awarded_by_label: awardSourceLabel(row),
  }));
}

async function listAvailableBadges(tenantId, memberId) {
  const [{ data: badges, error: badgeError }, { data: active, error: activeError }] = await Promise.all([
    supabase.from('badge').select('id, name, description, image_url').eq('tenant_id', tenantId).eq('is_active', true).order('name'),
    supabase.from('member_badge').select('badge_id').eq('tenant_id', tenantId).eq('member_id', memberId).is('revoked_at', null),
  ]);
  if (badgeError) throw badgeError;
  if (activeError) throw activeError;
  const held = new Set((active || []).map((row) => row.badge_id));
  return (badges || []).filter((badge) => !held.has(badge.id));
}

export default async function handler(req, res) {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const context = await getTenantContext(req);
    if (!context?.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
    if (!context.tenantId) return res.status(403).json({ error: 'Tenant context required' });

    const memberId = req.query?.memberId;
    if (!memberId) return res.status(400).json({ error: 'Member id is required' });
    const targetAccess = await checkMemberBadgeTargetAccess(context, memberId);
    if (!targetAccess.ok) {
      return res.status(targetAccess.status).json({ error: targetAccess.error });
    }
    const { data: member, error: memberError } = await loadScopedMember(context.tenantId, memberId);
    if (memberError) throw memberError;
    if (!member) return res.status(404).json({ error: 'Member not found' });

    const writeAccess = await checkBadgeWriteAccess(context);
    const canManage = writeAccess.ok && context.memberId !== memberId;

    if (req.method === 'GET') {
      const awards = await listMemberBadges(context.tenantId, memberId);
      const availableBadges = canManage ? await listAvailableBadges(context.tenantId, memberId) : [];
      return res.json({ awards, availableBadges, canManage });
    }

    if (!writeAccess.ok) {
      return res.status(writeAccess.status).json({ error: writeAccess.error });
    }
    if (context.memberId === memberId) {
      return res.status(403).json({ error: 'You cannot award or revoke your own badges' });
    }
    const actor = await resolveBadgeActor(supabase, context);

    if (req.method === 'POST') {
      const badgeId = req.body?.badgeId;
      if (!badgeId) return res.status(400).json({ error: 'Badge id is required' });
      const { data: badge, error: badgeError } = await supabase
        .from('badge')
        .select('id')
        .eq('id', badgeId)
        .eq('tenant_id', context.tenantId)
        .eq('is_active', true)
        .maybeSingle();
      if (badgeError) throw badgeError;
      if (!badge) return res.status(404).json({ error: 'Active badge not found' });

      const { data: award, error } = await supabase
        .from('member_badge')
        .insert({
          tenant_id: context.tenantId,
          member_id: memberId,
          badge_id: badgeId,
          source: 'manual',
          created_by: actor.label,
          awarded_by_type: actor.type,
          awarded_by_id: actor.id,
          awarded_by_label: actor.label,
        })
        .select('id')
        .single();
      if (error?.code === '23505') {
        return res.status(409).json({ error: 'This member already has an active award for that badge' });
      }
      if (error) throw error;
      return res.status(201).json({ award, awards: await listMemberBadges(context.tenantId, memberId) });
    }

    const assignmentId = req.body?.assignmentId;
    if (!assignmentId) return res.status(400).json({ error: 'Assignment id is required' });
    const now = new Date().toISOString();
    const { data: revoked, error } = await supabase
      .from('member_badge')
      .update({
        revoked_at: now,
        revoked_by_type: actor.type,
        revoked_by_id: actor.id,
        revoked_by_label: actor.label,
      })
      .eq('id', assignmentId)
      .eq('tenant_id', context.tenantId)
      .eq('member_id', memberId)
      .is('revoked_at', null)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!revoked) return res.status(404).json({ error: 'Active badge award not found' });
    return res.json({ revoked, awards: await listMemberBadges(context.tenantId, memberId) });
  } catch (error) {
    console.error('[Member badges]', error);
    return res.status(500).json({ error: 'Failed to update member badges' });
  }
}
