import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../../_lib/tenantResolver.js';
import OpenAI from 'openai';

function getOpenAIClient() {
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  if (!apiKey) return null;
  return new OpenAI({ apiKey, ...(baseURL && { baseURL }) });
}

async function moderateMessage(text) {
  const client = getOpenAIClient();
  if (!client) {
    return { is_safe: true, reason: '' };
  }

  try {
    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a content moderation system. Always respond with valid JSON.' },
        {
          role: 'user',
          content: `Analyze the following well-wisher message for inappropriate content including profanity, hate speech, sexually explicit material, threats, or harassment.\n\nMessage: "${text}"\n\nRespond with a JSON object containing:\n- "is_safe": true if appropriate, false if inappropriate\n- "reason": brief explanation if flagged, empty string if safe`
        }
      ],
      max_completion_tokens: 256,
      response_format: { type: 'json_object' }
    });

    const content = completion.choices[0]?.message?.content || '';
    const result = JSON.parse(content);
    return { is_safe: !!result.is_safe, reason: result.reason || '' };
  } catch (err) {
    console.error('[Wellwisher] Moderation error:', err.message);
    return { is_safe: true, reason: '' };
  }
}

export default async function handler(req, res) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  if (req.method === 'POST') {
    try {
      const tenant = await resolveTenantFromRequest(req);
      if (!tenant?.id) {
        return res.status(404).json({ error: 'Tenant not found' });
      }

      const { token, name, message, email, marketing_consent } = req.body;

      if (!token || !name?.trim()) {
        return res.status(400).json({ error: 'token and name are required' });
      }

      const { data: teamMember, error: tmError } = await supabase
        .from('fundraising_team_member')
        .select('id, campaign_id, tenant_id')
        .eq('token', token)
        .eq('is_active', true)
        .single();

      if (tmError || !teamMember) {
        return res.status(404).json({ error: 'Donation page not found' });
      }

      if (teamMember.tenant_id !== tenant.id) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      const { data: campaign } = await supabase
        .from('fundraising_campaign')
        .select('status')
        .eq('id', teamMember.campaign_id)
        .eq('tenant_id', tenant.id)
        .single();

      if (!campaign || campaign.status !== 'active') {
        return res.status(400).json({ error: 'This campaign is not currently accepting well wishes' });
      }

      if (message?.trim()) {
        const moderation = await moderateMessage(message.trim());
        if (!moderation.is_safe) {
          return res.status(400).json({
            error: 'Your message was flagged for inappropriate content. Please revise and try again.',
            moderation_reason: moderation.reason
          });
        }
      }

      const { data: wellwisher, error: insertError } = await supabase
        .from('fundraising_wellwisher')
        .insert({
          tenant_id: tenant.id,
          campaign_id: teamMember.campaign_id,
          team_member_id: teamMember.id,
          name: name.trim(),
          email: email?.trim() || null,
          message: message?.trim() || null,
          marketing_consent: !!marketing_consent,
          marketing_consent_at: marketing_consent ? new Date().toISOString() : null
        })
        .select()
        .single();

      if (insertError) {
        console.error('[Wellwisher] Insert error:', insertError);
        return res.status(500).json({ error: 'Failed to save well wish' });
      }

      return res.status(201).json(wellwisher);
    } catch (err) {
      console.error('[Wellwisher] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
