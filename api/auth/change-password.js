import bcrypt from 'bcryptjs';
import { getSessionMember } from '../_lib/session.js';
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

  // Get member from PostgreSQL session (same as login uses)
  const sessionMember = await getSessionMember(req);

  if (!sessionMember) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }

  const memberId = sessionMember.id;

  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, error: 'Current and new password are required' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, error: 'New password must be at least 8 characters' });
    }

    const { data: credentials, error: credError } = await supabase
      .from('member_credentials')
      .select('*')
      .eq('member_id', memberId)
      .single();

    if (credError || !credentials) {
      return res.status(404).json({ success: false, error: 'Credentials not found' });
    }

    if (credentials.password_hash) {
      const isValid = await bcrypt.compare(currentPassword, credentials.password_hash);
      if (!isValid) {
        return res.status(401).json({ success: false, error: 'Current password is incorrect' });
      }
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);

    await supabase
      .from('member_credentials')
      .update({ 
        password_hash: passwordHash,
        is_temp_password: false,
        password_set_at: new Date().toISOString()
      })
      .eq('id', credentials.id);

    console.log('[Auth] Password changed for member:', memberId);
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ success: false, error: 'Failed to change password' });
  }
}
