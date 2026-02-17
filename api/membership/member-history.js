import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const sessionMember = await getSessionMember(req);
  if (!sessionMember) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const tenantId = sessionMember.tenant_id;
  const organizationId = sessionMember.organization_id;

  if (!organizationId) {
    return res.status(400).json({ error: 'No organisation associated with this account' });
  }

  try {
    const { data, error } = await supabase
      .from('organisation_membership_history')
      .select('id, tenant_id, organization_id, membership_year, tier_name, band_label, annual_cost, pro_rata_cost, free_period_discount, rollover_discount, custom_discount_total, final_cost, vat_rate, vat_amount, total_with_vat, xero_invoice_id, xero_invoice_number, purchase_order_number, payment_method, stripe_payment_intent_id, created_at')
      .eq('tenant_id', tenantId)
      .eq('organization_id', organizationId)
      .order('membership_year', { ascending: false });

    if (error) {
      console.error('[member-history] Error fetching membership history:', error);
      return res.status(500).json({ error: 'Failed to fetch membership history' });
    }

    return res.json(data || []);
  } catch (error) {
    console.error('[member-history] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
