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

/**
 * Builds a map of lowercased member email → organization_id for a tenant.
 * When a member email appears in multiple organizations (edge case), the first
 * encountered row wins (deterministic: Supabase returns rows in insert order).
 */
export async function getOrgMapForTenant(tenantId) {
  const { data: members, error } = await supabase
    .from('member')
    .select('email, organization_id')
    .eq('tenant_id', tenantId)
    .not('email', 'is', null)
    .not('organization_id', 'is', null);

  if (error) {
    console.error('[AgentEmails] Error fetching member org map:', error);
    return new Map();
  }

  const map = new Map();
  for (const m of members || []) {
    const key = m.email.toLowerCase();
    if (!map.has(key)) {
      map.set(key, m.organization_id);
    }
  }

  return map;
}

/**
 * Returns true when the sender AND every To/CC recipient all resolve to members
 * of exactly one shared organization within the tenant.
 *
 * Returns false (i.e. keep the email) if:
 *  - any participant is unresolved (email not in orgMap)
 *  - participants span more than one organization
 *  - there are no recipients at all
 */
export function isIntraOrgEmail(fromAddress, toAddresses, ccAddresses, orgMap) {
  if (!orgMap || orgMap.size === 0) {
    return false;
  }

  const from = fromAddress?.toLowerCase();
  if (!from) {
    return false;
  }

  const allRecipients = [
    ...(toAddresses || []).map(r => (r.address || r).toLowerCase()),
    ...(ccAddresses || []).map(r => (r.address || r).toLowerCase())
  ].filter(Boolean);

  if (allRecipients.length === 0) {
    return false;
  }

  const fromOrg = orgMap.get(from);
  if (!fromOrg) {
    return false;
  }

  const orgIds = new Set([fromOrg]);

  for (const email of allRecipients) {
    const orgId = orgMap.get(email);
    if (!orgId) {
      return false;
    }
    orgIds.add(orgId);
  }

  return orgIds.size === 1;
}
