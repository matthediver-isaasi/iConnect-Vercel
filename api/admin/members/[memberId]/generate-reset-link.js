import { getSessionMember } from '../../../_lib/session.js';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

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
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ success: false, error: 'Database not configured' });
  }

  const sessionMember = await getSessionMember(req);
  
  if (!sessionMember) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }

  try {
    // Check if user has access to password reset feature
    const roleId = sessionMember.role_id;
    if (roleId) {
      const { data: role, error: roleError } = await supabase
        .from('role')
        .select('excluded_features')
        .eq('id', roleId)
        .single();

      if (!roleError && role) {
        const excludedFeatures = role.excluded_features || [];
        if (excludedFeatures.includes('crm.members.password_reset')) {
          return res.status(403).json({ success: false, error: 'Access denied' });
        }
      }
    }

    const { memberId } = req.query;

    if (!memberId) {
      return res.status(400).json({ success: false, error: 'Member ID required' });
    }

    // Fetch target member with tenant scoping for security
    const { data: member, error: memberError } = await supabase
      .from('member')
      .select('id, email, first_name, tenant_id')
      .eq('id', memberId)
      .single();

    if (memberError || !member) {
      return res.status(404).json({ success: false, error: 'Member not found' });
    }

    // Ensure the requesting member belongs to the same tenant as the target member
    if (member.tenant_id !== sessionMember.tenant_id) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    const resetToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const { data: existingCreds } = await supabase
      .from('member_credentials')
      .select('id')
      .eq('member_id', member.id)
      .single();

    if (existingCreds) {
      await supabase
        .from('member_credentials')
        .update({ 
          reset_token: resetToken,
          reset_token_expires: expiresAt.toISOString()
        })
        .eq('id', existingCreds.id);
    } else {
      await supabase
        .from('member_credentials')
        .insert({
          member_id: member.id,
          email: member.email.toLowerCase(),
          reset_token: resetToken,
          reset_token_expires: expiresAt.toISOString()
        });
    }

    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers.host;
    const resetUrl = `${protocol}://${host}/auth/reset-password?token=${resetToken}&email=${encodeURIComponent(member.email)}`;
    
    console.log(`[Reset Link] Generated for ${member.email} by member ${sessionMember.id} in tenant ${sessionMember.tenant_id}`);

    return res.json({ 
      success: true, 
      resetUrl,
      expiresAt: expiresAt.toISOString(),
      memberEmail: member.email
    });
  } catch (error) {
    console.error('[Admin Reset Link] Error:', error);
    return res.status(500).json({ success: false, error: 'Failed to generate reset link' });
  }
}
