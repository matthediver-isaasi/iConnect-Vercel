export function envelopeIsTest(messageData) {
  const value = messageData['o:testmode'];
  if (value == null || value === 'no' || value === false) return false;
  if (value === 'yes' || value === true) return true;
  throw new Error('Unrecognized Mailgun test mode; campaign delivery refused.');
}

// Conditional writes plus a complete read-back verify ownership and immutable
// provenance, including when a previous attempt committed but lost its response.
// Never overwrite an existing value, even following a confirmed rejection.
export async function persistCampaignDeliveryProvenance(db, campaignId, entries, messageData) {
  const isTest = envelopeIsTest(messageData);
  const ids = entries.map(entry => entry.recipient.id);
  if (!ids.length || ids.some(id => id == null) || new Set(ids).size !== ids.length) {
    throw new Error('Invalid campaign delivery provenance recipients.');
  }
  const { error } = await db.from('email_campaign_recipient')
    .update({ delivery_is_test: isTest }).eq('campaign_id', campaignId)
    .eq('status', 'processing').in('id', ids).is('delivery_is_test', null);
  if (error) throw new Error(`Could not persist campaign delivery provenance: ${error.message || error}`);
  const { data, error: readError } = await db.from('email_campaign_recipient')
    .select('id, delivery_is_test').eq('campaign_id', campaignId)
    .eq('status', 'processing').in('id', ids);
  if (readError || !Array.isArray(data) || data.length !== ids.length ||
      new Set(data.map(row => row.id)).size !== ids.length ||
      data.some(row => !ids.includes(row.id) || row.delivery_is_test !== isTest)) {
    throw new Error('Campaign delivery provenance or claim could not be verified; no email submitted.');
  }
  for (const entry of entries) entry.recipient.delivery_is_test = isTest;
}

// Reconciliation cannot infer provenance from today's campaign setting.
export async function verifyCampaignDeliveryProvenance(db, campaignId, recipientId) {
  const { data, error } = await db.from('email_campaign_recipient')
    .select('delivery_is_test').eq('campaign_id', campaignId)
    .eq('id', recipientId).eq('status', 'processing').maybeSingle();
  if (error || typeof data?.delivery_is_test !== 'boolean') {
    throw new Error('Accepted campaign delivery has no verified provenance; reconciliation required.');
  }
}
