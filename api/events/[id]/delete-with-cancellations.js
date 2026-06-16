// Admin endpoint: cancel every active booking on a simple Event (running the
// per-booking cancellation pipeline + cancellation emails) and then hard-delete
// the event row + orphan rows. See api/_lib/eventDeletion.js for the full
// behaviour and idempotency notes (task-700).

import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';
import { deleteEventWithCancellations } from '../../_lib/eventDeletion.js';
import { authorizeGroupAdminEventDelete } from '../../_lib/groupAdminEventWrite.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  const ctx = await getTenantContext(req);
  if (!ctx.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });

  const tenantId = ctx.tenantId;
  if (!tenantId) return res.status(400).json({ error: 'Tenant context required' });

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Event id required' });

  // Tenant admins always allowed; Group Admins only for events they administer (Task #1519).
  const delAuthz = await authorizeGroupAdminEventDelete({ eventId: id, eventTable: 'event', tenantCtx: ctx, req });
  if (!delAuthz.ok) return res.status(delAuthz.status || 403).json({ error: delAuthz.error });

  const { organiser_message, suppress_emails } = req.body || {};

  let adminLabel = 'Admin';
  try {
    if (ctx.tenantUserId) {
      const { data: tu } = await supabase.from('tenant_user').select('email, name').eq('id', ctx.tenantUserId).maybeSingle();
      if (tu) adminLabel = tu.email || tu.name || 'Admin';
    } else if (ctx.memberId) {
      const { data: m } = await supabase.from('member').select('email, first_name, last_name').eq('id', ctx.memberId).maybeSingle();
      if (m) adminLabel = m.email || [m.first_name, m.last_name].filter(Boolean).join(' ') || 'Admin';
    }
  } catch {}

  const result = await deleteEventWithCancellations({
    eventId: id,
    tenantId,
    eventTable: 'event',
    organiserMessage: organiser_message || null,
    adminLabel,
    suppressEmails: suppress_emails === true,
  });

  if (result.status === 'not_found') return res.status(404).json(result);
  if (result.status === 'deleted') return res.json(result);
  return res.status(409).json(result);
}
