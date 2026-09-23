import { supabase } from '../../_lib/database.js';
import { getAgentEmailsForTenant, isAgentOnlyEmail, getOrgMapForTenant, isIntraOrgEmail } from '../../_lib/agentEmails.js';
import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';

export async function handleMemberEmailHistory(req, res, dependencies = {}) {
  const database = dependencies.database || supabase;
  const loadContext = dependencies.getTenantContext || getTenantContext;
  const checkAdmin = dependencies.hasAdminAccess || hasAdminAccess;
  const loadAgentEmails = dependencies.getAgentEmailsForTenant || getAgentEmailsForTenant;
  const loadOrgMap = dependencies.getOrgMapForTenant || getOrgMapForTenant;
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
    if (!database) return res.status(503).json({ error: 'Database not configured' });
    const context = await loadContext(req);
    if (!context?.isAuthenticated || !context.tenantId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    if (context.tenantMismatch || !(await checkAdmin(context))) {
      return res.status(403).json({ error: 'Administrator access required' });
    }
    if (!req.headers?.['x-tenant-id'] || req.headers['x-tenant-id'] !== context.tenantId) {
      return res.status(403).json({ error: 'Tenant context does not match' });
    }

    const { memberId } = req.query;
    
    if (typeof memberId !== 'string' || !memberId.trim()) {
      return res.status(400).json({ error: 'Member ID is required' });
    }

    const { data: member, error: memberError } = await database
      .from('member')
      .select('id, email, tenant_id')
      .eq('id', memberId)
      .eq('tenant_id', context.tenantId)
      .maybeSingle();

    if (memberError) throw memberError;
    if (!member || /^deleted_.+@deleted\.local$/i.test(String(member.email || ''))) {
      return res.status(404).json({ error: 'Member not found' });
    }

    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    const [agentEmails, orgMap] = await Promise.all([
      loadAgentEmails(context.tenantId),
      loadOrgMap(context.tenantId)
    ]);

    // Fetch emails for this member with a reasonable max limit
    // We filter agent-only and intra-org emails in memory to handle JSONB recipient arrays
    // Max 1000 emails per member to prevent memory issues
    const MAX_EMAILS_PER_MEMBER = 1000;
    const { data: allEmails, error: emailsError } = await database
      .from('member_email')
      .select('*, synced_by_identity_id')
      .eq('tenant_id', context.tenantId)
      .eq('member_id', memberId)
      .order('sent_at', { ascending: false, nullsFirst: false })
      .order('received_at', { ascending: false, nullsFirst: false })
      .limit(MAX_EMAILS_PER_MEMBER);

    if (emailsError) {
      console.error('[Outlook Emails] Email history query failed');
      return res.status(500).json({ error: 'Failed to fetch emails' });
    }

    // Filter out agent-only and intra-org emails
    const filteredEmails = (allEmails || []).filter(email => {
      const toAddresses = email.to_addresses || [];
      const ccAddresses = email.cc_addresses || [];
      return (
        !isAgentOnlyEmail(email.from_address, toAddresses, ccAddresses, agentEmails) &&
        !isIntraOrgEmail(email.from_address, toAddresses, ccAddresses, orgMap)
      );
    });

    // Apply pagination to filtered results
    const paginatedEmails = filteredEmails.slice(offset, offset + limit);

    // Get agent display names for attribution
    const identityIds = [...new Set(paginatedEmails.map(e => e.synced_by_identity_id).filter(Boolean))];
    let agentNames = {};
    
    if (identityIds.length > 0) {
      const { data: connections } = await database
        .from('outlook_connection')
        .select('identity_id, display_name, microsoft_email')
        .eq('tenant_id', context.tenantId)
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
    console.error('[Outlook Emails] Unexpected history failure');
    return res.status(500).json({ error: 'Internal server error' });
  }
}

export default function handler(req, res) {
  return handleMemberEmailHistory(req, res);
}
