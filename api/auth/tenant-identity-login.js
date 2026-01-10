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
    const { email, password, tenantId } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    const { data: identity, error: identityError } = await supabase
      .from('tenant_identity')
      .select('*')
      .eq('email', email.toLowerCase())
      .single();

    if (identityError || !identity) {
      const { data: legacyCreds } = await supabase
        .from('tenant_user_credentials')
        .select('*')
        .eq('email', email.toLowerCase())
        .single();
      
      if (legacyCreds) {
        console.log('[Tenant Identity] Falling back to legacy auth for:', email);
        return handleLegacyLogin(req, res, email, password);
      }
      
      console.log('[Tenant Identity] No identity found for:', email);
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    if (identity.locked_until && new Date(identity.locked_until) > new Date()) {
      return res.status(401).json({ success: false, error: 'Account temporarily locked. Please try again later.' });
    }

    if (!identity.password_hash) {
      return res.status(401).json({ 
        success: false, 
        error: 'Password not set', 
        needsPasswordSetup: true
      });
    }

    const isValid = await bcrypt.compare(password, identity.password_hash);
    
    if (!isValid) {
      const newFailedAttempts = (identity.failed_attempts || 0) + 1;
      const updates = { failed_attempts: newFailedAttempts };
      
      if (newFailedAttempts >= 5) {
        updates.locked_until = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      }
      
      await supabase
        .from('tenant_identity')
        .update(updates)
        .eq('id', identity.id);
      
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    await supabase
      .from('tenant_identity')
      .update({ 
        failed_attempts: 0, 
        locked_until: null,
        last_login: new Date().toISOString()
      })
      .eq('id', identity.id);

    const { data: memberships, error: membershipError } = await supabase
      .from('tenant_membership')
      .select('*, tenant:tenant_id(*)')
      .eq('identity_id', identity.id)
      .eq('status', 'active')
      .order('is_default', { ascending: false })
      .order('last_accessed', { ascending: false, nullsFirst: false });

    if (membershipError || !memberships || memberships.length === 0) {
      console.log('[Tenant Identity] No active memberships for:', email);
      return res.status(403).json({ success: false, error: 'No active tenant memberships found.' });
    }

    let selectedMembership;
    if (tenantId) {
      selectedMembership = memberships.find(m => m.tenant_id === tenantId);
      if (!selectedMembership) {
        return res.status(403).json({ success: false, error: 'You do not have access to this tenant.' });
      }
    } else if (memberships.length === 1) {
      selectedMembership = memberships[0];
    } else {
      return res.json({
        success: true,
        requiresTenantSelection: true,
        identity: {
          id: identity.id,
          email: identity.email,
          first_name: identity.first_name,
          last_name: identity.last_name
        },
        tenants: memberships.map(m => ({
          id: m.tenant_id,
          name: m.tenant?.name,
          slug: m.tenant?.slug,
          logo_url: m.tenant?.logo_url,
          role: m.role,
          is_default: m.is_default
        }))
      });
    }

    await supabase
      .from('tenant_membership')
      .update({ last_accessed: new Date().toISOString() })
      .eq('id', selectedMembership.id);

    await createSession(res, {
      identityId: identity.id,
      tenantUserId: identity.id, // For backwards compatibility
      tenantUserEmail: identity.email,
      tenantId: selectedMembership.tenant_id,
      membershipId: selectedMembership.id,
      membershipRole: selectedMembership.role,
      userType: 'tenant_user'
    });

    console.log('[Tenant Identity] Login success for:', email, 'tenant:', selectedMembership.tenant?.name);
    
    res.json({ 
      success: true, 
      tenantUser: {
        id: identity.id,
        email: identity.email,
        first_name: identity.first_name,
        last_name: identity.last_name,
        role: selectedMembership.role
      },
      tenant: selectedMembership.tenant,
      hasMultipleTenants: memberships.length > 1
    });
  } catch (error) {
    console.error('[Tenant Identity] Login error:', error);
    res.status(500).json({ success: false, error: 'Login failed' });
  }
}

async function handleLegacyLogin(req, res, email, password) {
  try {
    const { data: credentials, error: credError } = await supabase
      .from('tenant_user_credentials')
      .select('*')
      .eq('email', email.toLowerCase())
      .single();

    if (credError || !credentials) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    if (credentials.locked_until && new Date(credentials.locked_until) > new Date()) {
      return res.status(401).json({ success: false, error: 'Account temporarily locked.' });
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
      return res.status(403).json({ success: false, error: 'Account is inactive.' });
    }

    // Create session with all required fields for tenant isolation
    const sessionData = {
      identityId: tenantUser.identity_id || tenantUser.id,
      tenantUserId: tenantUser.id,
      tenantUserEmail: tenantUser.email,
      tenantId: tenantUser.tenant_id,  // Critical for tenant isolation
      userType: 'tenant_user'
    };

    console.log('[Tenant Legacy] Creating session with tenantId:', tenantUser.tenant_id);
    await createSession(res, sessionData);
    
    res.json({ 
      success: true, 
      tenantUser: {
        id: tenantUser.id,
        email: tenantUser.email,
        first_name: tenantUser.first_name,
        last_name: tenantUser.last_name,
        role: tenantUser.role
      },
      tenant: tenantUser.tenant,
      hasMultipleTenants: false
    });
  } catch (error) {
    console.error('[Tenant Legacy] Login error:', error);
    res.status(500).json({ success: false, error: 'Login failed' });
  }
}
