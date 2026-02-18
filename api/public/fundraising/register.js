import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../../_lib/tenantResolver.js';
import crypto from 'crypto';
import OpenAI from 'openai';

let openaiClient = null;
function getOpenAIClient() {
  if (openaiClient) return openaiClient;
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  if (!apiKey) return null;
  openaiClient = new OpenAI({ apiKey, ...(baseURL && { baseURL }) });
  return openaiClient;
}

async function moderateTeamName(name) {
  const client = getOpenAIClient();
  if (!client) {
    return { is_safe: true, reason: '' };
  }
  try {
    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a content moderator. Given a team name, determine if it is appropriate for a public fundraising campaign. Reject names that are offensive, contain profanity, slurs, hate speech, sexual content, or are clearly inappropriate. Be lenient with creative or playful names. Respond with valid JSON only: {"is_safe": true/false, "reason": "explanation if unsafe"}'
        },
        { role: 'user', content: `Team name: "${name}"` }
      ],
      response_format: { type: 'json_object' },
      max_completion_tokens: 256,
    });
    const result = JSON.parse(completion.choices[0]?.message?.content || '{}');
    return { is_safe: result.is_safe !== false, reason: result.reason || '' };
  } catch (err) {
    console.error('[Fundraising Register] LLM moderation error:', err.message);
    return { is_safe: true, reason: '' };
  }
}

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const tenant = await resolveTenantFromRequest(req);
    if (!tenant?.id) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const { campaign_slug, first_name, last_name, email, individual_goal, team_members, team_name, organisation, existing_organisation_id, participation_type } = req.body;

    if (!campaign_slug) {
      return res.status(400).json({ error: 'Campaign slug is required' });
    }
    if (!first_name?.trim() || !last_name?.trim()) {
      return res.status(400).json({ error: 'First name and last name are required' });
    }
    if (!email?.trim()) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const { data: campaign, error: campError } = await supabase
      .from('fundraising_campaign')
      .select('id, name, slug, status, campaign_type, max_team_size, registration_open, registration_message, currency, auto_create_organisations, auto_create_members, member_role_id, allow_org_signup')
      .eq('tenant_id', tenant.id)
      .eq('slug', campaign_slug)
      .single();

    if (campError || !campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    if (campaign.status !== 'active') {
      return res.status(400).json({ error: 'This campaign is not currently accepting registrations' });
    }

    if (!campaign.registration_open) {
      return res.status(400).json({ error: 'Registration is currently closed for this campaign' });
    }

    const { data: existingMember } = await supabase
      .from('fundraising_team_member')
      .select('id')
      .eq('campaign_id', campaign.id)
      .eq('tenant_id', tenant.id)
      .ilike('email', email.trim())
      .single();

    if (existingMember) {
      return res.status(409).json({ error: 'This email is already registered for this campaign' });
    }

    const effectiveType = campaign.campaign_type === 'both'
      ? (participation_type || 'individual')
      : campaign.campaign_type;
    const isTeamCampaign = effectiveType === 'team';
    const maxTeamSize = campaign.max_team_size || 5;
    const maxAdditional = maxTeamSize - 1;

    if (campaign.campaign_type === 'both' && !['individual', 'team'].includes(participation_type)) {
      return res.status(400).json({ error: 'Please select whether you are joining as an individual or a team' });
    }

    const validTeamMembers = isTeamCampaign && Array.isArray(team_members)
      ? team_members.filter(m => m.first_name?.trim() && m.last_name?.trim() && m.email?.trim())
      : [];

    if (isTeamCampaign && Array.isArray(team_members)) {
      const membersWithoutEmail = team_members.filter(m => m.first_name?.trim() && m.last_name?.trim() && !m.email?.trim());
      if (membersWithoutEmail.length > 0) {
        return res.status(400).json({ error: 'All team members must have an email address' });
      }
    }

    if (isTeamCampaign && validTeamMembers.length > maxAdditional) {
      return res.status(400).json({
        error: `Team size exceeds the maximum of ${maxTeamSize} members (including yourself). Please remove ${validTeamMembers.length - maxAdditional} member(s).`
      });
    }

    const allEmails = [email.trim().toLowerCase()];
    for (const tm of validTeamMembers) {
      if (tm.email?.trim()) {
        const tmEmail = tm.email.trim().toLowerCase();
        if (allEmails.includes(tmEmail)) {
          return res.status(400).json({ error: `Duplicate email in submission: ${tm.email.trim()}` });
        }
        allEmails.push(tmEmail);
      }
    }

    if (allEmails.length > 1) {
      const { data: existingMembers } = await supabase
        .from('fundraising_team_member')
        .select('email')
        .eq('campaign_id', campaign.id)
        .eq('tenant_id', tenant.id)
        .in('email', allEmails.map(e => e));

      if (existingMembers && existingMembers.length > 0) {
        const existingEmails = existingMembers.map(m => m.email?.toLowerCase());
        const duplicates = allEmails.filter(e => existingEmails.includes(e));
        if (duplicates.length > 0) {
          return res.status(409).json({
            error: `The following email(s) are already registered for this campaign: ${duplicates.join(', ')}`
          });
        }
      }
    }

    if (isTeamCampaign && team_name) {
      const trimmedTeamName = team_name.trim();
      if (trimmedTeamName.length < 2 || trimmedTeamName.length > 100) {
        return res.status(400).json({ error: 'Team name must be between 2 and 100 characters' });
      }

      const { data: existingTeamName } = await supabase
        .from('fundraising_team_member')
        .select('id')
        .eq('campaign_id', campaign.id)
        .eq('tenant_id', tenant.id)
        .ilike('team_name', trimmedTeamName)
        .limit(1);

      if (existingTeamName && existingTeamName.length > 0) {
        return res.status(409).json({ error: 'This team name is already taken for this campaign. Please choose a different name.' });
      }

      const moderation = await moderateTeamName(trimmedTeamName);
      if (!moderation.is_safe) {
        return res.status(400).json({
          error: moderation.reason || 'The team name was flagged as inappropriate. Please choose a different name.'
        });
      }
    } else if (isTeamCampaign && !team_name?.trim()) {
      return res.status(400).json({ error: 'Team name is required for team registrations' });
    }

    let createdOrgId = null;

    if (existing_organisation_id) {
      const { data: verifiedOrg } = await supabase
        .from('organization')
        .select('id')
        .eq('id', existing_organisation_id)
        .eq('tenant_id', tenant.id)
        .single();

      if (verifiedOrg) {
        createdOrgId = verifiedOrg.id;
        console.log(`[Fundraising Register] Using existing organisation: ${existing_organisation_id}`);
      } else {
        console.warn(`[Fundraising Register] Provided existing_organisation_id not found: ${existing_organisation_id}`);
      }
    } else if (campaign.auto_create_organisations && campaign.allow_org_signup && organisation?.name) {
      try {
        const { data: existingOrg } = await supabase
          .from('organization')
          .select('id')
          .eq('tenant_id', tenant.id)
          .ilike('name', organisation.name)
          .single();

        if (existingOrg) {
          createdOrgId = existingOrg.id;
          console.log(`[Fundraising Register] Organisation already exists: ${organisation.name} (${existingOrg.id})`);
        } else {
          const addressObj = {};
          if (organisation.address) addressObj.line1 = organisation.address;
          if (organisation.city) addressObj.city = organisation.city;
          if (organisation.postcode) addressObj.postcode = organisation.postcode;
          if (organisation.country) addressObj.country = organisation.country;

          const { data: newOrg, error: orgError } = await supabase
            .from('organization')
            .insert({
              tenant_id: tenant.id,
              name: organisation.name,
              address: Object.keys(addressObj).length > 0 ? addressObj : null
            })
            .select('id')
            .single();

          if (orgError) {
            console.error('[Fundraising Register] Error creating organisation:', orgError);
          } else {
            createdOrgId = newOrg.id;
            console.log(`[Fundraising Register] Created organisation: ${organisation.name} (${newOrg.id})`);
          }
        }
      } catch (orgErr) {
        console.error('[Fundraising Register] Organisation creation error:', orgErr);
      }
    }

    const createdMembers = [];

    const leadInsert = {
      tenant_id: tenant.id,
      campaign_id: campaign.id,
      first_name: first_name.trim(),
      last_name: last_name.trim(),
      email: email.trim(),
      token: generateToken(),
      individual_goal: individual_goal ? parseFloat(individual_goal) : null,
      team_name: isTeamCampaign && team_name ? team_name.trim() : null,
      is_active: true
    };
    if (createdOrgId) leadInsert.organization_id = createdOrgId;

    const { data: leadMember, error: leadError } = await supabase
      .from('fundraising_team_member')
      .insert(leadInsert)
      .select()
      .single();

    if (leadError) {
      console.error('[Fundraising Register] Error creating lead member:', leadError);
      return res.status(500).json({ error: 'Failed to register. Please try again.' });
    }

    createdMembers.push({
      id: leadMember.id,
      first_name: leadMember.first_name,
      last_name: leadMember.last_name,
      email: leadMember.email,
      token: leadMember.token,
      role: 'lead'
    });

    if (isTeamCampaign && validTeamMembers.length > 0) {
      for (const tm of validTeamMembers) {
        const tmInsert = {
          tenant_id: tenant.id,
          campaign_id: campaign.id,
          first_name: tm.first_name.trim(),
          last_name: tm.last_name.trim(),
          email: tm.email?.trim() || null,
          token: generateToken(),
          individual_goal: null,
          team_name: team_name ? team_name.trim() : null,
          is_active: true
        };
        if (createdOrgId) tmInsert.organization_id = createdOrgId;

        const { data: teamMember, error: tmError } = await supabase
          .from('fundraising_team_member')
          .insert(tmInsert)
          .select()
          .single();

        if (tmError) {
          console.error('[Fundraising Register] Error creating team member:', tmError);
          continue;
        }

        createdMembers.push({
          id: teamMember.id,
          first_name: teamMember.first_name,
          last_name: teamMember.last_name,
          email: teamMember.email,
          token: teamMember.token,
          role: 'member'
        });
      }
    }

    if (campaign.auto_create_members) {
      try {
        const allRegistrants = [
          { first_name: first_name.trim(), last_name: last_name.trim(), email: email.trim() },
          ...validTeamMembers.map(m => ({
            first_name: m.first_name.trim(),
            last_name: m.last_name.trim(),
            email: m.email?.trim() || null
          }))
        ];

        for (const registrant of allRegistrants) {
          if (!registrant.email) continue;

          const { data: existingMemberRecord } = await supabase
            .from('member')
            .select('id')
            .eq('tenant_id', tenant.id)
            .ilike('email', registrant.email)
            .single();

          if (existingMemberRecord) {
            console.log(`[Fundraising Register] Member record already exists for: ${registrant.email}`);
            continue;
          }

          const memberInsert = {
            tenant_id: tenant.id,
            first_name: registrant.first_name,
            last_name: registrant.last_name,
            email: registrant.email
          };

          if (campaign.member_role_id) {
            memberInsert.role_id = campaign.member_role_id;
          }

          const { error: memberError } = await supabase
            .from('member')
            .insert(memberInsert);

          if (memberError) {
            console.error(`[Fundraising Register] Error creating member record for ${registrant.email}:`, memberError);
          } else {
            console.log(`[Fundraising Register] Created member record for: ${registrant.email}`);
          }
        }
      } catch (memberErr) {
        console.error('[Fundraising Register] Member creation error:', memberErr);
      }
    }

    return res.status(201).json({
      success: true,
      campaign_name: campaign.name,
      campaign_type: campaign.campaign_type,
      registration_message: campaign.registration_message,
      members: createdMembers
    });
  } catch (error) {
    console.error('[Fundraising Register] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
