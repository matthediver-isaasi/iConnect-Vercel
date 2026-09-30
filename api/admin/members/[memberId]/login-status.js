import { getSessionMember } from '../../../_lib/session.js';
import { createClient } from '@supabase/supabase-js';
import { isResourceExcluded } from '../../../_lib/roleVisibility.js';
import { getEffectiveLoginStatusForMember } from '../../../_lib/memberLoginResolver.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

async function verifyPermission(req) {
  const sessionMember = await getSessionMember(req);
  if (!sessionMember) return { hasPermission: false, error: 'Not authenticated' };
  if (!sessionMember.role_id) return { hasPermission: false };
  if (!supabase) return { hasPermission: false, error: 'Database not configured' };
  try {
    const { data: role } = await supabase
      .from('role')
      .select('excluded_features')
      .eq('id', sessionMember.role_id)
      .single();
    if (!role) return { hasPermission: false };
    const excluded = role.excluded_features || [];
    if (!isResourceExcluded(excluded, 'admin.role-management')) {
      return { hasPermission: true };
    }
    return { hasPermission: !isResourceExcluded(excluded, 'admin_can_edit_members') };
  } catch (err) {
    console.error('[LoginStatus Permission] error:', err);
    return { hasPermission: false, error: 'Verification failed' };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { hasPermission, error } = await verifyPermission(req);
  if (error) return res.status(401).json({ error });
  if (!hasPermission) return res.status(403).json({ error: 'Permission denied' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  const { memberId } = req.query;
  try {
    const { data: member, error: memberError } = await supabase
      .from('member')
      .select('*')
      .eq('id', memberId)
      .single();
    if (memberError || !member) {
      return res.status(404).json({ error: 'Member not found' });
    }
    const status = await getEffectiveLoginStatusForMember(member, { supabase });
    return res.json(status);
  } catch (err) {
    console.error('[LoginStatus] error:', err);
    return res.status(500).json({ error: 'Failed to compute login status' });
  }
}
