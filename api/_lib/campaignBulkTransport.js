// Only ordinary newsletters enter the first bulk transport. Event and survey
// messages keep their existing recipient-by-recipient delivery authority.
export const BULK_TRANSPORT = 'mailgun_batch_v1';
export function newCampaignTransport(campaign, env = process.env) {
  return env.CAMPAIGN_MAILGUN_BATCH_ENABLED === 'true' &&
    (campaign.is_test_mode === true || env.CAMPAIGN_MAILGUN_BATCH_LIVE_ENABLED === 'true')
    ? BULK_TRANSPORT : 'individual';
}
export function bulkCampaignCompatible(campaign) {
  const content = `${campaign.subject || ''}\n${campaign.html_content || ''}\n${JSON.stringify(campaign.design_json || {})}`;
  const hasSurveyContext = campaign.event_survey_context &&
    Object.keys(campaign.event_survey_context).length > 0;
  return !campaign.member_group_id && !campaign.group_id && !campaign.event_id && !hasSurveyContext
    && !campaign.attachments?.length
    && !/(?:\{\{|\[\[)[^}\]]*(?:event[._]|booking[._]|survey|set_password_url)|EVENT_QR_BLOCK/i.test(content);
}

export function buildBulkEnvelope(campaignId, messages) {
  if (!messages.length || messages.length > 100) throw new Error('Invalid campaign batch size');
  const variableFields = ['subject', 'html', 'text', 'h:List-Unsubscribe'];
  const common = message => Object.fromEntries(Object.entries(message)
    .filter(([key]) => !['to', ...variableFields].includes(key)));
  const first = messages[0];
  const base = common(first.messageData);
  if (base.cc || base.bcc || base.attachment || base.inline) throw new Error('Unsupported batch envelope');
  const variables = {};
  const addresses = [];
  for (const { domain, messageData: message } of messages) {
    if (domain !== first.domain || JSON.stringify(common(message)) !== JSON.stringify(base)) {
      throw new Error('Incompatible campaign batch envelopes');
    }
    const address = Array.isArray(message.to) && message.to.length === 1 ? message.to[0] : null;
    if (typeof address !== 'string' || !/^[^\s<>@,*]+@[^\s<>@,*]+$/.test(address)) throw new Error('Invalid batch recipient');
    const key = address.toLowerCase();
    if (Object.hasOwn(variables, key)) throw new Error('Duplicate batch recipient');
    addresses.push(key);
    variables[key] = {};
    for (let i = 0; i < variableFields.length; i++) {
      const value = message[variableFields[i]] || '';
      // Do not let template-looking source text become another provider token.
      if (/%recipient[.%]/i.test(value)) throw new Error('Nested provider variables are not batch compatible');
      variables[key][`field${i}`] = value;
    }
  }
  const data = { ...base, to: addresses, 'v:iconn_campaign_id': campaignId,
    'recipient-variables': JSON.stringify(variables) };
  variableFields.forEach((field, i) => { data[field] = `%recipient.field${i}%`; });
  // Bound payloads below Mailgun's message-size limit, including multipart overhead.
  if (Buffer.byteLength(JSON.stringify(data)) > 8_000_000) {
    const error = new Error('Campaign batch payload too large');
    error.code = 'CAMPAIGN_BATCH_TOO_LARGE';
    throw error;
  }
  return { domain: first.domain, messageData: data };
}

// Choose the largest prefix fitting the actual encoded envelope, including
// UTF-8, JSON escaping and recipient-variable overhead. Non-size incompatibility
// retains the existing individual fallback; never split an uncertain submission.
export function fittingCampaignBatchSize(campaignId, messages) {
  if (!messages.length || messages.length > 100) throw new Error('Invalid campaign batch size');
  const fits = size => {
    try { buildBulkEnvelope(campaignId, messages.slice(0, size)); return true; }
    catch (error) {
      if (error.code === 'CAMPAIGN_BATCH_TOO_LARGE') return false;
      throw error;
    }
  };
  try {
    if (fits(messages.length)) return messages.length;
    // A single oversized message may still use the existing individual path.
    if (!fits(1)) return 1;
    let low = 1, high = messages.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(mid)) low = mid;
      else high = mid - 1;
    }
    return low;
  } catch {
    return messages.length;
  }
}
