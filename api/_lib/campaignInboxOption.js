// This option is channel selection, never an email-consent exception.
export function validateCampaignInboxOption(data) {
  if (Object.hasOwn(data, 'deliver_to_inbox_when_opted_out') &&
      typeof data.deliver_to_inbox_when_opted_out !== 'boolean') {
    throw new Error('deliver_to_inbox_when_opted_out must be a boolean');
  }
}

export async function publishCampaignInbox(db, campaign, recipient, content) {
  const { data, error } = await db.rpc('publish_campaign_inbox_only', {
    p_campaign: campaign.id, p_tenant: campaign.tenant_id,
    p_recipient: recipient.id, p_subject: content.subject, p_html: content.html,
  });
  if (error) throw error;
  if (data !== true) throw new Error('Inbox publication was not confirmed');
}
