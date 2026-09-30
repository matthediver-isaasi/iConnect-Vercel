import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, tenant: tenantParam } = req.body;

  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Email is required' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('[CheckMemberEmail] Missing Supabase credentials');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const tenant = await resolveTenantFromRequest(req);

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const { data: member, error } = await supabase
      .from('member')
      .select('id')
      .eq('tenant_id', tenant.id)
      .ilike('email', normalizedEmail)
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('[CheckMemberEmail] Database error:', error);
      return res.status(500).json({ error: 'Failed to check email' });
    }

    return res.status(200).json({ isMember: !!member });
  } catch (err) {
    console.error('[CheckMemberEmail] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
