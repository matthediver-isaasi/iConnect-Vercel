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

    // Fetch emails from ALL agents' connections for this member (collective CRM view)
    // This aggregates emails synced by any agent in the tenant
    const { data: emails, error: emailsError, count } = await supabase
      .from('member_email')
      .select('*, synced_by_identity_id', { count: 'exact' })
      .eq('tenant_id', session.tenantId)
      .eq('member_id', memberId)
      .order('sent_at', { ascending: false, nullsFirst: false })
      .order('received_at', { ascending: false, nullsFirst: false })
      .range(offset, offset + limit - 1);

    if (emailsError) {
      console.error('[Outlook Emails] Database error:', emailsError);
      return res.status(500).json({ error: 'Failed to fetch emails' });
    }

    // Get agent display names for attribution
    const identityIds = [...new Set((emails || []).map(e => e.synced_by_identity_id).filter(Boolean))];
    let agentNames = {};
    
    if (identityIds.length > 0) {
      // Get Outlook connection display names for each identity
      const { data: connections } = await supabase
        .from('outlook_connection')
        .select('identity_id, display_name, microsoft_email')
        .eq('tenant_id', session.tenantId)
        .in('identity_id', identityIds);
      
      if (connections) {
        for (const conn of connections) {
          agentNames[conn.identity_id] = conn.display_name || conn.microsoft_email || 'Unknown Agent';
        }
      }
    }

    // Enrich emails with agent attribution
    const enrichedEmails = (emails || []).map(email => ({
      ...email,
      synced_by_name: email.synced_by_identity_id ? agentNames[email.synced_by_identity_id] || 'Unknown Agent' : null
    }));

    res.status(200).json({
      emails: enrichedEmails,
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
