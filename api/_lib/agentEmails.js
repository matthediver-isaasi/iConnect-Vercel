import { supabase } from './database.js';

export async function getAgentEmailsForTenant(tenantId) {
  const { data: connections, error } = await supabase
    .from('outlook_connection')
    .select('microsoft_email')
    .eq('tenant_id', tenantId)
    .eq('status', 'active');

  if (error) {
    console.error('[AgentEmails] Error fetching agent emails:', error);
    return new Set();
  }

  const emails = new Set();
  for (const conn of connections || []) {
    if (conn.microsoft_email) {
      emails.add(conn.microsoft_email.toLowerCase());
    }
  }

  return emails;
}

export function isAgentOnlyEmail(fromAddress, toAddresses, ccAddresses, agentEmails) {
  if (!agentEmails || agentEmails.size === 0) {
    return false;
  }

  const from = fromAddress?.toLowerCase();
  if (!from || !agentEmails.has(from)) {
    return false;
  }

  const allRecipients = [
    ...(toAddresses || []).map(r => (r.address || r).toLowerCase()),
    ...(ccAddresses || []).map(r => (r.address || r).toLowerCase())
  ].filter(Boolean);

  if (allRecipients.length === 0) {
    return false;
  }

  return allRecipients.every(email => agentEmails.has(email));
}
