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
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const { data: member, error: memberError } = await supabase
      .from('member')
      .select('id, email')
      .eq('email', email.toLowerCase())
      .single();

    if (memberError || !member) {
      return res.json({ exists: false, hasPassword: false });
    }

    const { data: credentials } = await supabase
      .from('member_credentials')
      .select('id, password_hash')
      .eq('member_id', member.id)
      .single();

    res.json({ 
      exists: true, 
      hasPassword: !!(credentials?.password_hash),
      memberId: member.id
    });
  } catch (error) {
    console.error('Check password status error:', error);
    res.status(500).json({ error: 'Failed to check status' });
  }
}
