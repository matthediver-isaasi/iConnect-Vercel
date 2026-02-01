import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const tenant = await resolveTenantFromRequest(req);

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const { data: jobPostings, error } = await supabase
      .from('job_posting')
      .select(`
        id,
        title,
        description,
        company_name,
        company_logo_url,
        location,
        salary_range,
        job_type,
        hours,
        application_method,
        application_value,
        contact_email,
        posted_by_organization_id,
        posted_by_organization_name,
        status,
        closing_date,
        expiry_date,
        featured,
        created_date
      `)
      .eq('tenant_id', tenant.id)
      .eq('status', 'active')
      .order('created_date', { ascending: false });

    if (error) {
      console.error('[Public JobPostings] Query error:', error);
      return res.status(500).json({ error: 'Failed to fetch job postings' });
    }

    return res.status(200).json(jobPostings || []);
  } catch (error) {
    console.error('[Public JobPostings] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
