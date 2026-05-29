/* deploy-trigger: 2026-05-29 */
/**
 * GET /api/admin/onboarding-checklist
 *
 * Returns a small set of "first thing" milestones the dashboard checklist
 * card renders. Each item carries a status flag and (when relevant) a deep
 * link that takes the admin straight into the right configuration page.
 */

import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';

async function tableCount(tenantId, table, extraFilter) {
  let q = supabase.from(table).select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId);
  if (extraFilter) q = extraFilter(q);
  const { count } = await q;
  return count || 0;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  const ctx = await getTenantContext(req);
  if (!ctx?.tenantId) return res.status(401).json({ error: 'Authentication required' });
  if (!(await hasAdminAccess(ctx))) return res.status(403).json({ error: 'Admin access required' });

  const tenantId = ctx.tenantId;

  const [
    realMembers, sampleMembers, realEvents, realResources, realPosts,
    integrationsRow, intentRows, brandingRow,
  ] = await Promise.all([
    tableCount(tenantId, 'member', q => q.eq('is_sample', false)),
    tableCount(tenantId, 'member', q => q.eq('is_sample', true)),
    tableCount(tenantId, 'event', q => q.eq('is_sample', false)),
    tableCount(tenantId, 'resource', q => q.eq('is_sample', false)),
    tableCount(tenantId, 'blog_post', q => q.eq('is_sample', false)),
    supabase.from('tenant_integrations').select('integration_type, is_enabled').eq('tenant_id', tenantId),
    supabase.from('tenant_integration_intent').select('integration_type, intent, configured_at').eq('tenant_id', tenantId),
    supabase.from('tenant').select('primary_color, logo_url').eq('id', tenantId).single(),
  ]);

  const enabled = new Set(
    (integrationsRow.data || []).filter(r => r.is_enabled).map(r => r.integration_type),
  );
  const intentByType = Object.fromEntries((intentRows.data || []).map(r => [r.integration_type, r]));

  const branding = brandingRow.data || {};
  const brandingDone = Boolean(branding.primary_color && branding.logo_url);

  const checklist = [
    {
      key: 'branding',
      label: 'Set your colours & logo',
      done: brandingDone,
      link: '/admin/branding',
    },
    {
      key: 'invite_real_member',
      label: 'Invite your first real member',
      done: realMembers > 0,
      link: '/MemberRoleAssignment',
    },
    {
      key: 'first_event',
      label: 'Create your first event',
      done: realEvents > 0,
      link: '/CreateEvent',
    },
    {
      key: 'first_resource',
      label: 'Upload a resource',
      done: realResources > 0,
      link: '/ResourceManagement',
    },
    {
      key: 'first_post',
      label: 'Publish your first post',
      done: realPosts > 0,
      link: '/Articles',
    },
    {
      key: 'connect_payments',
      label: 'Connect Stripe for payments',
      done: enabled.has('stripe'),
      intent: intentByType.stripe?.intent || null,
      link: '/admin/integrations',
    },
    {
      key: 'connect_accounting',
      label: 'Connect accounting (Xero or QuickBooks)',
      done: enabled.has('xero') || enabled.has('quickbooks'),
      intent: intentByType.xero?.intent || intentByType.quickbooks?.intent || null,
      link: '/admin/integrations',
    },
    {
      key: 'connect_zoom',
      label: 'Connect Zoom for online events',
      done: enabled.has('zoom'),
      intent: intentByType.zoom?.intent || null,
      link: '/admin/integrations',
    },
  ];

  const sampleContentPresent = sampleMembers > 0
    || (await tableCount(tenantId, 'event', q => q.eq('is_sample', true))) > 0
    || (await tableCount(tenantId, 'resource', q => q.eq('is_sample', true))) > 0
    || (await tableCount(tenantId, 'blog_post', q => q.eq('is_sample', true))) > 0;

  const done = checklist.filter(i => i.done).length;
  return res.status(200).json({
    checklist,
    progress: { done, total: checklist.length },
    sample_content_present: sampleContentPresent,
  });
}
