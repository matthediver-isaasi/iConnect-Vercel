import { getSession } from '../../_lib/session.js';
import { supabase } from '../../_lib/database.js';
import { getAgentEmailsForTenant, isAgentOnlyEmail } from '../../_lib/agentEmails.js';

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

    const agentEmails = await getAgentEmailsForTenant(session.tenantId);

    // Fetch emails for this member with a reasonable max limit
    // We filter agent-only emails in memory to handle JSONB recipient arrays
    // Max 1000 emails per member to prevent memory issues
    const MAX_EMAILS_PER_MEMBER = 1000;
    const { data: allEmails, error: emailsError } = await supabase
      .from('member_email')
      .select('*, synced_by_identity_id')
      .eq('tenant_id', session.tenantId)
      .eq('member_id', memberId)
      .order('sent_at', { ascending: false, nullsFirst: false })
      .order('received_at', { ascending: false, nullsFirst: false })
      .limit(MAX_EMAILS_PER_MEMBER);

    if (emailsError) {
      console.error('[Outlook Emails] Database error:', emailsError);
      return res.status(500).json({ error: 'Failed to fetch emails' });
    }

    // Filter out agent-only emails
    const filteredEmails = (allEmails || []).filter(email => {
      const toAddresses = email.to_addresses || [];
      const ccAddresses = email.cc_addresses || [];
      return !isAgentOnlyEmail(email.from_address, toAddresses, ccAddresses, agentEmails);
    });

    // Apply pagination to filtered results
    const paginatedEmails = filteredEmails.slice(offset, offset + limit);

    // Get agent display names for attribution
    const identityIds = [...new Set(paginatedEmails.map(e => e.synced_by_identity_id).filter(Boolean))];
    let agentNames = {};
    
    if (identityIds.length > 0) {
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

    const enrichedEmails = paginatedEmails.map(email => ({
      ...email,
      synced_by_name: email.synced_by_identity_id ? agentNames[email.synced_by_identity_id] || 'Unknown Agent' : null
    }));

    res.status(200).json({
      emails: enrichedEmails,
      total: filteredEmails.length,
      limit,
      offset,
      memberEmail: member.email
    });
  } catch (error) {
    console.error('[Outlook Emails] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
