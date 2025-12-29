import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import { createSession } from '../_lib/session.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

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
      
      // First check if credentials exist for this member
      const { data: allCreds, error: allCredsError } = await supabase
        .from('member_credentials')
        .select('id, member_id, reset_token, reset_token_expires')
        .eq('member_id', member.id);
      
      if (allCredsError) {
        console.error('[Auth] Error fetching credentials:', allCredsError);
      } else {
        console.log(`[Auth] Found ${allCreds?.length || 0} credential records for member ${member.id}`);
        if (allCreds?.length > 0) {
          const cred = allCreds[0];
          console.log(`[Auth] Stored token prefix: ${cred.reset_token?.substring(0, 8) || 'null'}..., expires: ${cred.reset_token_expires}`);
        }
      }
      
      const { data: credentials, error: credError } = await supabase
        .from('member_credentials')
        .select('*')
        .eq('member_id', member.id)
        .eq('reset_token', token)
        .single();

      if (credError || !credentials) {
        const storedToken = allCreds?.[0]?.reset_token;
        const tokenMatch = storedToken === token;
        console.error('[Auth] Token validation failed:', {
          error: credError?.message || 'No matching credentials found',
          providedTokenPrefix: token?.substring(0, 8),
          storedTokenPrefix: storedToken?.substring(0, 8),
          tokensMatch: tokenMatch,
          hasCredentials: allCreds?.length > 0
        });
        
        // Provide more helpful error message
        if (allCreds?.length === 0) {
          return res.status(401).json({ success: false, error: 'No password setup was initiated for this account. Please contact support.' });
        } else if (!storedToken) {
          return res.status(401).json({ success: false, error: 'This password reset link has already been used. Please request a new one.' });
        } else {
          return res.status(401).json({ success: false, error: 'Invalid or expired reset token' });
        }
      }

      if (credentials.reset_token_expires && new Date(credentials.reset_token_expires) < new Date()) {
        console.log('[Auth] Token expired at:', credentials.reset_token_expires);
        return res.status(401).json({ success: false, error: 'Reset token has expired' });
      }
      
      console.log('[Auth] Token validated successfully');
    }

    const passwordHash = await bcrypt.hash(password, 12);

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
