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
  const memberId = sessionMember.id;

  try {
    let data, error;

    if (organizationId) {
      const result = await supabase
        .from('organisation_membership_history')
        .select('id, tenant_id, organization_id, membership_year, tier_label, band_id, annual_cost, prorata_cost, free_period_discount, rollover_discount, custom_discount_total, final_cost, vat_rate, currency, xero_invoice_id, xero_invoice_number, purchase_order_number, payment_method, stripe_payment_intent_id, status, created_at')
        .eq('tenant_id', tenantId)
        .eq('organization_id', organizationId)
        .order('membership_year', { ascending: false });
      data = result.data;
      error = result.error;
    } else {
      const result = await supabase
        .from('member_membership_history')
        .select('id, tenant_id, member_id, membership_year, tier_label, band_id, annual_cost, prorata_cost, free_period_discount, rollover_discount, custom_discount_total, final_cost, currency, xero_invoice_id, xero_invoice_number, purchase_order_number, payment_method, stripe_payment_intent_id, status, created_at, vat_rate_percent, vat_amount, total_with_vat')
        .eq('tenant_id', tenantId)
        .eq('member_id', memberId)
        .order('membership_year', { ascending: false });
      data = result.data;
      error = result.error;
    }

    if (error) {
      console.error('[member-history] Error fetching membership history:', error);
      return res.status(500).json({ error: 'Failed to fetch membership history' });
    }

    const records = data || [];

    const bandIds = [...new Set(records.map(r => r.band_id).filter(Boolean))];
    let bandMap = {};
    if (bandIds.length > 0) {
      const { data: bands } = await supabase
        .from('membership_tier_band')
        .select('id, label')
        .in('id', bandIds);
      if (bands) {
        for (const b of bands) {
          bandMap[b.id] = b.label;
        }
      }
    }

    const enriched = records.map(r => ({
      ...r,
      band_label: r.band_id ? (bandMap[r.band_id] || null) : null,
    }));

    return res.json(enriched);
  } catch (error) {
    console.error('[member-history] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
