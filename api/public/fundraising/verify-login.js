import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../../_lib/tenantResolver.js';
import crypto from 'crypto';
import { fetchDashboardData } from './verify-session.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const tenant = await resolveTenantFromRequest(req);
    if (!tenant?.id) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const token = req.query.token;
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    const { data: tokenRecord, error: tokenError } = await supabase
      .from('fundraising_login_token')
      .select('*')
      .eq('token', token)
      .eq('tenant_id', tenant.id)
      .single();

    if (tokenError || !tokenRecord) {
      return res.status(401).json({ error: 'Invalid or expired login link' });
    }

    if (tokenRecord.type === 'session') {
      return res.status(401).json({ error: 'Invalid or expired login link' });
    }

    if (new Date(tokenRecord.expires_at) < new Date()) {
      await supabase.from('fundraising_login_token').delete().eq('id', tokenRecord.id);
      return res.status(401).json({ error: 'Login link has expired. Please request a new one.' });
    }

    const email = tokenRecord.email;

    const dashboardData = await fetchDashboardData(supabase, tenant.id, email);

    if (!dashboardData) {
      await supabase.from('fundraising_login_token').delete().eq('id', tokenRecord.id);
      return res.status(404).json({ error: 'No active fundraising campaigns found for this email' });
    }

    const sessionToken = crypto.randomUUID();
    const sessionExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const { error: sessionInsertError } = await supabase
      .from('fundraising_login_token')
      .insert({
        tenant_id: tenant.id,
        email,
        token: sessionToken,
        type: 'session',
        expires_at: sessionExpiresAt
      });

    if (sessionInsertError) {
      console.error('Failed to create session token:', sessionInsertError);
    }

    await supabase.from('fundraising_login_token').delete().eq('id', tokenRecord.id);

    return res.status(200).json({
      ...dashboardData,
      session_token: sessionToken
    });
  } catch (err) {
    console.error('Verify fundraiser login error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
