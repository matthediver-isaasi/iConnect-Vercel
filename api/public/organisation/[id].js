import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../../_lib/tenantResolver.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id, tenant: tenantParam } = req.query;

  if (!id) {
    return res.status(400).json({ error: 'Organisation ID is required' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    let tenantId = null;
    
    // First try: centralized tenant resolver (subdomain and custom domain)
    const tenant = await resolveTenantFromRequest(req);
    if (tenant) {
      tenantId = tenant.id;
    }
    
    // Second try: explicit tenant query parameter (for local dev, embedded forms, etc.)
    if (!tenantId && tenantParam) {
      // Try slug first
      let { data: tenantBySlug } = await supabase
        .from('tenant')
        .select('id')
        .eq('slug', tenantParam)
        .eq('status', 'active')
        .single();
      
      if (tenantBySlug) {
        tenantId = tenantBySlug.id;
      } else {
        // Fallback to subdomain field for legacy tenants
        const { data: tenantBySubdomain } = await supabase
          .from('tenant')
          .select('id')
          .eq('subdomain', tenantParam)
          .eq('status', 'active')
          .single();
        
        if (tenantBySubdomain) {
          tenantId = tenantBySubdomain.id;
        }
      }
    }
    
    if (!tenantId) {
      return res.status(400).json({ error: 'Invalid tenant context' });
    }

    // Fetch organization with whitelisted fields for form prefill
    // Includes fields commonly used in prefill mappings, excluding sensitive financial/internal data
    // Note: training_fund_balance and internal notes are intentionally excluded for public safety
    const publicFields = [
      'id', 'name', 'status', 'email', 'phone', 'website', 'website_url',
      'address', 'city', 'state', 'country', 'postal_code',
      'invoicing_email', 'invoicing_address', 'invoicing_contact',
      'logo_url', 'description', 'domain', 'map',
      'abn', 'acn', 'registration_number', 'industry', 'size', 'type',
      'primary_contact_name', 'primary_contact_email', 'primary_contact_phone',
      'billing_contact_name', 'billing_contact_email', 'billing_contact_phone',
      'membership_start_date', 'membership_end_date', 'membership_type',
      'employee_count', 'annual_revenue_range', 'founded_year',
      'linkedin_url', 'twitter_url', 'facebook_url'
    ].join(', ');
    
    const { data: org, error: orgError } = await supabase
      .from('organization')
      .select(publicFields + ', tenant_id')
      .eq('id', id)
      .single();

    if (orgError || !org) {
      return res.status(404).json({ error: 'Organisation not found' });
    }

    // Enforce tenant isolation - org must belong to requesting tenant
    if (org.tenant_id && org.tenant_id !== tenantId) {
      return res.status(404).json({ error: 'Organisation not found' });
    }

    // Remove internal fields from response
    const { tenant_id, ...publicOrg } = org;

    return res.json(publicOrg);
  } catch (error) {
    console.error('Public organization fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch organization' });
  }
}
