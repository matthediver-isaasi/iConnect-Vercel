import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../../_lib/tenantResolver.js';
import crypto from 'crypto';

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

    const { campaign_slug, first_name, last_name, email, individual_goal, team_members, organisation, existing_organisation_id } = req.body;

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

    const isTeamCampaign = campaign.campaign_type === 'team';
    const maxTeamSize = campaign.max_team_size || 5;
    const maxAdditional = maxTeamSize - 1;

    const validTeamMembers = isTeamCampaign && Array.isArray(team_members)
      ? team_members.filter(m => m.first_name?.trim() && m.last_name?.trim())
      : [];

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

    const createdMembers = [];

    const leadToken = generateToken();
    const { data: leadMember, error: leadError } = await supabase
      .from('fundraising_team_member')
      .insert({
        tenant_id: tenant.id,
        campaign_id: campaign.id,
        first_name: first_name.trim(),
        last_name: last_name.trim(),
        email: email.trim(),
        token: leadToken,
        individual_goal: individual_goal ? parseFloat(individual_goal) : null,
        is_active: true
      })
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
        const memberToken = generateToken();
        const { data: teamMember, error: tmError } = await supabase
          .from('fundraising_team_member')
          .insert({
            tenant_id: tenant.id,
            campaign_id: campaign.id,
            first_name: tm.first_name.trim(),
            last_name: tm.last_name.trim(),
            email: tm.email?.trim() || null,
            token: memberToken,
            individual_goal: null,
            is_active: true
          })
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

    let createdOrgId = null;

    if (existing_organisation_id) {
      const { data: verifiedOrg } = await supabase
        .from('organisation')
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
          .from('organisation')
          .select('id')
          .eq('tenant_id', tenant.id)
          .ilike('name', organisation.name)
          .single();

        if (existingOrg) {
          createdOrgId = existingOrg.id;
          console.log(`[Fundraising Register] Organisation already exists: ${organisation.name} (${existingOrg.id})`);
        } else {
          const { data: newOrg, error: orgError } = await supabase
            .from('organisation')
            .insert({
              tenant_id: tenant.id,
              name: organisation.name,
              address_line_1: organisation.address || null,
              city: organisation.city || null,
              postcode: organisation.postcode || null,
              country: organisation.country || null
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

          if (createdOrgId) {
            memberInsert.organization_id = createdOrgId;
          }

          const { error: memberError } = await supabase
            .from('member')
            .insert(memberInsert);

          if (memberError) {
            console.error(`[Fundraising Register] Error creating member record for ${registrant.email}:`, memberError);
          } else {
            console.log(`[Fundraising Register] Created member record for: ${registrant.email}${createdOrgId ? ` (linked to org ${createdOrgId})` : ''}`);
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
