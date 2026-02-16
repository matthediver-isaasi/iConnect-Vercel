import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../../_lib/tenantResolver.js';

const WHITELISTED_MEMBER_FIELDS = [
  'id', 'first_name', 'last_name', 'email', 'phone', 'mobile',
  'job_title', 'organization_id', 'status', 'address_line_1',
  'address_line_2', 'city', 'county', 'postcode', 'country',
  'date_of_birth', 'gender', 'title', 'middle_name', 'suffix',
  'preferred_name', 'company_name', 'department', 'website'
];

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { member_id, form_slug, tenant: tenantParam } = req.query;

  if (!member_id) {
    return res.status(400).json({ error: 'member_id is required' });
  }
  if (!form_slug) {
    return res.status(400).json({ error: 'form_slug is required' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    let tenantId = null;

    const tenant = await resolveTenantFromRequest(req);
    if (tenant) {
      tenantId = tenant.id;
    }

    if (!tenantId && tenantParam) {
      let { data: tenantBySlug } = await supabase
        .from('tenant')
        .select('id')
        .eq('slug', tenantParam)
        .eq('status', 'active')
        .single();

      if (tenantBySlug) {
        tenantId = tenantBySlug.id;
      } else {
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

    const { data: form, error: formError } = await supabase
      .from('form')
      .select('id, prefill_source')
      .eq('slug', form_slug)
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .single();

    if (formError || !form) {
      return res.status(404).json({ error: 'Form not found' });
    }

    if (form.prefill_source !== 'member') {
      return res.status(400).json({ error: 'Form is not configured for member prefill' });
    }

    const { data: member, error: memberError } = await supabase
      .from('member')
      .select('*')
      .eq('id', member_id)
      .eq('tenant_id', tenantId)
      .single();

    if (memberError || !member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    const publicMember = {};
    for (const field of WHITELISTED_MEMBER_FIELDS) {
      if (member[field] !== undefined) {
        publicMember[field] = member[field];
      }
    }

    const { data: customValues, error: cvError } = await supabase
      .from('member_preference_value')
      .select('id, member_id, field_id, value')
      .eq('member_id', member_id)
      .eq('tenant_id', tenantId);

    if (cvError) {
      console.error('[Public Prefill Member] Error fetching custom values:', cvError);
    }

    return res.json({
      member: publicMember,
      customValues: customValues || []
    });
  } catch (error) {
    console.error('[Public Prefill Member] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch member data' });
  }
}
