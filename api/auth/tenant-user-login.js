import bcrypt from 'bcryptjs';
import { createSession } from '../_lib/session.js';
import { supabase } from '../_lib/database.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

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
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    const { data: credentials, error: credError } = await supabase
      .from('tenant_user_credentials')
      .select('*')
      .eq('email', email.toLowerCase())
      .single();

    if (credError || !credentials) {
      console.log('[Tenant Auth] No credentials found for:', email);
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    if (credentials.locked_until && new Date(credentials.locked_until) > new Date()) {
      return res.status(401).json({ success: false, error: 'Account temporarily locked. Please try again later.' });
    }

    if (!credentials.password_hash) {
      return res.status(401).json({ 
        success: false, 
        error: 'Password not set', 
        needsPasswordSetup: true
      });
    }

    const isValid = await bcrypt.compare(password, credentials.password_hash);
    
    if (!isValid) {
      const newFailedAttempts = (credentials.failed_attempts || 0) + 1;
      const updates = { failed_attempts: newFailedAttempts };
      
      if (newFailedAttempts >= 5) {
        updates.locked_until = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      }
      
      await supabase
        .from('tenant_user_credentials')
        .update(updates)
        .eq('id', credentials.id);
      
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    await supabase
      .from('tenant_user_credentials')
      .update({ 
        failed_attempts: 0, 
        locked_until: null,
        last_login: new Date().toISOString()
      })
      .eq('id', credentials.id);

    const { data: tenantUser, error: tenantUserError } = await supabase
      .from('tenant_user')
      .select('*, tenant:tenant_id(*)')
      .eq('id', credentials.tenant_user_id)
      .single();

    if (tenantUserError || !tenantUser) {
      return res.status(401).json({ success: false, error: 'Account not found' });
    }

    if (tenantUser.status !== 'active') {
      console.log('[Tenant Auth] Account inactive for:', email);
      return res.status(403).json({ success: false, error: 'Account is inactive. Please contact support.' });
    }

    await createSession(res, {
      tenantUserId: tenantUser.id,
      tenantUserEmail: tenantUser.email,
      tenantId: tenantUser.tenant_id,
      userType: 'tenant_user'
    });

    console.log('[Tenant Auth] Success for:', email);
    
    res.json({ 
      success: true, 
      tenantUser: {
        id: tenantUser.id,
        email: tenantUser.email,
        first_name: tenantUser.first_name,
        last_name: tenantUser.last_name,
        role: tenantUser.role
      },
      tenant: tenantUser.tenant
    });
  } catch (error) {
    console.error('[Tenant Auth] Login error:', error);
    res.status(500).json({ success: false, error: 'Login failed' });
  }
}
