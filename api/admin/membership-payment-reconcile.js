// Task #1017 — Admin endpoint backing the "Check now" button on the
// Membership Fee History card. Reconciles payment state for a single
// history row on demand. Requires tenant admin RBAC.

import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { supabase } from '../_lib/database.js';
import { reconcileMembershipInvoicePayment } from '../_lib/membershipPaymentReconciliation.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const tenantContext = await getTenantContext(req);
  if (!tenantContext?.isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (!(await hasAdminAccess(tenantContext))) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { recordId, table } = req.body || {};
  if (!recordId) return res.status(400).json({ error: 'recordId is required' });
  if (!table || (table !== 'organisation_membership_history' && table !== 'member_membership_history')) {
    return res.status(400).json({ error: 'Invalid table' });
  }

  const appTenantId = tenantContext.tenantId;
  if (!appTenantId) return res.status(400).json({ error: 'Tenant context required' });

  // Tenant boundary check: ensure the row belongs to the caller's tenant.
  const { data: row, error: rowErr } = await supabase
    .from(table)
    .select('id, tenant_id')
    .eq('id', recordId)
    .maybeSingle();

  if (rowErr) {
    console.error('[admin/membership-payment-reconcile] lookup failed:', rowErr);
    return res.status(500).json({ error: 'Failed to load record' });
  }
  if (!row) return res.status(404).json({ error: 'Record not found' });
  if (row.tenant_id !== appTenantId) return res.status(403).json({ error: 'Cross-tenant access denied' });

  const baseUrl = req.headers.host
    ? `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`
    : '';

  try {
    const outcome = await reconcileMembershipInvoicePayment({ table, recordId, baseUrl });
    return res.status(200).json({ ok: true, ...outcome });
  } catch (err) {
    console.error('[admin/membership-payment-reconcile] reconcile failed:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
