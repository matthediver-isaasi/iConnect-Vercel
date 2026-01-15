import bcrypt from 'bcryptjs';
import { supabase } from '../_lib/database.js';
import { createSession } from '../_lib/session.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const { token, email, password } = req.body;

    if (!token || !email || !password) {
      return res.status(400).json({ success: false, error: 'Token, email, and password are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
    }

    const { data: identity, error: identityError } = await supabase
      .from('tenant_identity')
      .select('*')
      .eq('email', email.toLowerCase())
      .eq('reset_token', token)
      .single();

    if (identityError || !identity) {
      return res.status(400).json({ success: false, error: 'Invalid or expired setup link' });
    }

    if (identity.reset_token_expires && new Date(identity.reset_token_expires) < new Date()) {
      return res.status(400).json({ success: false, error: 'Setup link has expired. Please contact your administrator.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const { error: updateError } = await supabase
      .from('tenant_identity')
      .update({
        password_hash: passwordHash,
        is_temporary: false,
        reset_token: null,
        reset_token_expires: null,
        updated_at: new Date().toISOString()
      })
      .eq('id', identity.id);

    if (updateError) {
      console.error('[Set Admin Password] Update error:', updateError);
      return res.status(500).json({ success: false, error: 'Failed to set password' });
    }

    const { data: membership } = await supabase
      .from('tenant_membership')
      .select('*, tenant:tenant_id(*)')
      .eq('identity_id', identity.id)
      .eq('membership_type', 'owner')
      .eq('status', 'active')
      .order('is_default', { ascending: false })
      .limit(1)
      .single();

    console.log(`[Set Admin Password] Password set for identity ${identity.id} (${identity.email})`);

    if (membership?.tenant) {
      const sessionData = {
        identityId: identity.id,
        tenantUserId: identity.id,
        tenantId: membership.tenant_id,
        email: identity.email,
        firstName: identity.first_name,
        lastName: identity.last_name,
        role: membership.role,
        userType: 'tenant_user'
      };

      await createSession(res, sessionData);

      return res.json({
        success: true,
        authenticated: true,
        tenantUser: {
          id: identity.id,
          email: identity.email,
          first_name: identity.first_name,
          last_name: identity.last_name,
          role: membership.role
        },
        tenant: {
          id: membership.tenant.id,
          name: membership.tenant.name,
          slug: membership.tenant.slug
        }
      });
    }

    return res.json({ success: true, message: 'Password set successfully. Please log in.' });
  } catch (error) {
    console.error('[Set Admin Password] Error:', error);
    return res.status(500).json({ success: false, error: 'Failed to set password' });
  }
}
