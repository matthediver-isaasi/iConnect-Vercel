import { getSession } from '../../_lib/session.js';
import { supabase } from '../../_lib/database.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const sessionResult = await getSession(req);
    
    if (!sessionResult || !sessionResult.data) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const session = sessionResult.data;
    if (!session.tenantId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { memberId } = req.query;
    
    if (!memberId) {
      return res.status(400).json({ error: 'Member ID is required' });
    }

    const { data: member, error: memberError } = await supabase
      .from('member')
      .select('id, email')
      .eq('id', memberId)
      .eq('tenant_id', session.tenantId)
      .single();

    if (memberError || !member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    const { data: emails, error: emailsError, count } = await supabase
      .from('member_email')
      .select('*', { count: 'exact' })
      .eq('tenant_id', session.tenantId)
      .eq('member_id', memberId)
      .order('sent_at', { ascending: false, nullsFirst: false })
      .order('received_at', { ascending: false, nullsFirst: false })
      .range(offset, offset + limit - 1);

    if (emailsError) {
      console.error('[Outlook Emails] Database error:', emailsError);
      return res.status(500).json({ error: 'Failed to fetch emails' });
    }

    res.status(200).json({
      emails: emails || [],
      total: count || 0,
      limit,
      offset,
      memberEmail: member.email
    });
  } catch (error) {
    console.error('[Outlook Emails] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
