import { getTargetRecipients } from './campaignService.js';

// Resolve the saved campaign's CURRENT eligible audience, not arbitrary member
// records or stale persisted delivery rows. Email is the live pipeline's dedupe key.
export async function campaignTestAudience(campaign, tenantId) {
  if (!tenantId || campaign.tenant_id !== tenantId) throw new Error('Campaign not found');
  const result = await getTargetRecipients(campaign, tenantId);
  if (!result.success) throw new Error(result.error || 'Unable to resolve campaign audience');
  return result.recipients;
}

export function selectCampaignTestSource(recipients, email) {
  if (typeof email !== 'string' || !email.trim()) throw new Error('Source recipient email required');
  const source = recipients.find(r => r.email?.trim().toLowerCase() === email.trim().toLowerCase());
  if (!source) throw new Error('Source recipient is no longer in this campaign audience. Search and select again.');
  return {
    ...source,
    member_id: source.member_id !== undefined ? source.member_id : source.id,
    id: 'test-source',
  };
}

export function searchCampaignTestSources(recipients, search = '', offset = 0) {
  const query = String(search).trim().toLowerCase().slice(0, 200);
  const start = Math.max(0, Number.parseInt(offset, 10) || 0);
  const matches = recipients.filter(r =>
    `${r.first_name || ''} ${r.last_name || ''} ${r.email || ''}`.toLowerCase().includes(query));
  return {
    recipients: matches.slice(start, start + 25).map(({ email, first_name, last_name }) => ({ email, first_name, last_name })),
    hasMore: matches.length > start + 25,
  };
}