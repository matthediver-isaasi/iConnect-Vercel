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
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  try {
    const { email, password, token } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
    }

    const { data: member, error: memberError } = await supabase
      .from('member')
      .select('id, email')
      .eq('email', email.toLowerCase())
      .single();

    if (memberError || !member) {
      return res.status(404).json({ success: false, error: 'Member not found' });
    }

    if (token) {
      console.log(`[Auth] Validating token for member ${member.id}, token prefix: ${token.substring(0, 8)}...`);
      
      let tokenValid = false;
      let tokenExpiry = null;
      
      // First check tenant_identity (unified auth system)
      const { data: identity } = await supabase
        .from('tenant_identity')
        .select('id, reset_token, reset_token_expires')
        .eq('email', email.toLowerCase())
        .eq('reset_token', token)
        .single();
      
      if (identity) {
        console.log('[Auth] Found token in tenant_identity');
        tokenValid = true;
        tokenExpiry = identity.reset_token_expires;
      } else {
        // Fall back to member_credentials for backwards compatibility
        const { data: credentials } = await supabase
          .from('member_credentials')
          .select('id, reset_token, reset_token_expires')
          .eq('member_id', member.id)
          .eq('reset_token', token)
          .single();
        
        if (credentials) {
          console.log('[Auth] Found token in member_credentials');
          tokenValid = true;
          tokenExpiry = credentials.reset_token_expires;
        }
      }
      
      if (!tokenValid) {
        console.error('[Auth] Token validation failed - token not found in either table');
        return res.status(401).json({ success: false, error: 'Invalid or expired reset token. Please request a new password reset.' });
      }

      if (tokenExpiry && new Date(tokenExpiry) < new Date()) {
        console.log('[Auth] Token expired at:', tokenExpiry);
        return res.status(401).json({ success: false, error: 'Reset token has expired. Please request a new one.' });
      }
      
      console.log('[Auth] Token validated successfully');
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // First, handle unified identity system (tenant_identity)
    const { data: existingIdentity } = await supabase
      .from('tenant_identity')
      .select('*')
      .eq('email', email.toLowerCase())
      .single();

    let identityId = existingIdentity?.id;

    if (existingIdentity) {
      // Update existing identity with new password
      const { error: identityUpdateError } = await supabase
        .from('tenant_identity')
        .update({ 
          password_hash: passwordHash,
          is_temporary: false,
          reset_token: null,
          reset_token_expires: null,
          failed_attempts: 0,
          locked_until: null,
          updated_at: new Date().toISOString()
        })
        .eq('id', existingIdentity.id);
      
      if (identityUpdateError) {
        console.error('[Auth] Failed to update identity password:', identityUpdateError);
      } else {
        console.log('[Auth] Updated identity password for:', email);
      }
    } else {
      // Create new identity
      const { data: fullMemberData } = await supabase
        .from('member')
        .select('first_name, last_name, organization_id')
        .eq('id', member.id)
        .single();

      const { data: newIdentity, error: identityInsertError } = await supabase
        .from('tenant_identity')
        .insert({
          email: email.toLowerCase(),
          first_name: fullMemberData?.first_name,
          last_name: fullMemberData?.last_name,
          password_hash: passwordHash,
          is_temporary: false
        })
        .select()
        .single();
      
      if (identityInsertError) {
        console.error('[Auth] Failed to create identity:', identityInsertError);
      } else {
        identityId = newIdentity.id;
        console.log('[Auth] Created new identity for:', email);
      }
    }

    // Link member to identity if not already linked
    if (identityId) {
      const { data: memberData } = await supabase
        .from('member')
        .select('identity_id, organization_id, tenant_id')
        .eq('id', member.id)
        .single();

      if (memberData && !memberData.identity_id) {
        await supabase
          .from('member')
          .update({ identity_id: identityId })
          .eq('id', member.id);
        console.log('[Auth] Linked member to identity');
      }

      // Get tenant_id (from member directly or via organization)
      let tenantId = memberData?.tenant_id;
      if (!tenantId && memberData?.organization_id) {
        const { data: org } = await supabase
          .from('organization')
          .select('tenant_id')
          .eq('id', memberData.organization_id)
          .single();
        tenantId = org?.tenant_id;
      }

      // Create tenant_membership if doesn't exist
      if (tenantId) {
        const { data: existingMembership } = await supabase
          .from('tenant_membership')
          .select('id')
          .eq('identity_id', identityId)
          .eq('tenant_id', tenantId)
          .single();

        if (!existingMembership) {
          await supabase
            .from('tenant_membership')
            .insert({
              identity_id: identityId,
              tenant_id: tenantId,
              member_id: member.id,
              role: 'member',
              membership_type: 'member',
              status: 'active',
              is_default: true
            });
          console.log('[Auth] Created tenant membership for member');
        }
      }
    }

    // Legacy: Also update member_credentials for backwards compatibility
    const { data: existingCreds } = await supabase
      .from('member_credentials')
      .select('id')
      .eq('member_id', member.id)
      .single();

    if (existingCreds) {
      const { error: updateError } = await supabase
        .from('member_credentials')
        .update({ 
          password_hash: passwordHash,
          is_temp_password: false,
          password_set_at: new Date().toISOString(),
          reset_token: null,
          reset_token_expires: null,
          failed_login_attempts: 0,
          locked_until: null
        })
        .eq('id', existingCreds.id);
      
      if (updateError) {
        console.error('[Auth] Failed to update password:', updateError);
        return res.status(500).json({ success: false, error: 'Failed to save password' });
      }
      console.log('[Auth] Updated existing credentials for:', email);
    } else {
      const { error: insertError } = await supabase
        .from('member_credentials')
        .insert({
          member_id: member.id,
          email: email.toLowerCase(),
          password_hash: passwordHash,
          is_temp_password: false,
          password_set_at: new Date().toISOString()
        });
      
      if (insertError) {
        console.error('[Auth] Failed to insert credentials:', insertError);
        return res.status(500).json({ success: false, error: 'Failed to save password' });
      }
      console.log('[Auth] Created new credentials for:', email);
    }

    const { data: fullMember } = await supabase
      .from('member')
      .select('*')
      .eq('id', member.id)
      .single();

    // Auto-generate handle if member doesn't have one
    if (fullMember && !fullMember.handle && (fullMember.first_name || fullMember.last_name || fullMember.email)) {
      console.log('[Auth SetPassword] Member has no handle, generating one...');
      
      try {
        const generateSlug = (text) => {
          return text
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
        };

        const { data: allMembersForHandles } = await supabase
          .from('member')
          .select('handle');
        
        const existingHandles = new Set(
          (allMembersForHandles || [])
            .map((m) => m.handle)
            .filter((h) => h !== null)
        );

        let baseHandle = '';
        if (fullMember.first_name && fullMember.last_name) {
          baseHandle = `${generateSlug(fullMember.first_name)}-${generateSlug(fullMember.last_name)}`;
        } else if (fullMember.first_name) {
          baseHandle = generateSlug(fullMember.first_name);
        } else if (fullMember.last_name) {
          baseHandle = generateSlug(fullMember.last_name);
        } else if (fullMember.email) {
          baseHandle = generateSlug(fullMember.email.split('@')[0]);
        }
        
        if (baseHandle.length < 3) baseHandle = 'member';
        if (baseHandle.length > 30) baseHandle = baseHandle.substring(0, 30);

        let handle = baseHandle;
        let counter = 1;
        while (existingHandles.has(handle)) {
          const suffix = `-${counter}`;
          handle = baseHandle.substring(0, 30 - suffix.length) + suffix;
          counter++;
        }

        const { error: updateError } = await supabase
          .from('member')
          .update({ handle })
          .eq('id', fullMember.id);

        if (!updateError) {
          fullMember.handle = handle;
          console.log('[Auth SetPassword] Generated and saved handle:', handle);
        }
      } catch (handleError) {
        console.error('[Auth SetPassword] Error generating handle:', handleError.message);
      }
    }

    // Create PostgreSQL-backed session (same as login.js)
    await createSession(res, {
      memberId: member.id,
      memberEmail: email.toLowerCase()
    });

    console.log('[Auth] Password set for:', email);
    res.json({ success: true, member: fullMember });
  } catch (error) {
    console.error('Set password error:', error);
    res.status(500).json({ success: false, error: 'Failed to set password' });
  }
}
