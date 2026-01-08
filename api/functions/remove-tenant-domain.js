import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';

const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;

async function isAdministrator(member) {
  if (!member?.role_id) return false;
  
  const { data: role } = await supabase
    .from('role')
    .select('name, excluded_features')
    .eq('id', member.role_id)
    .single();
  
  if (!role) return false;
  
  if (role.name === 'Administrator') return true;
  
  const excludedFeatures = role.excluded_features || [];
  return !excludedFeatures.some(f => f === 'admin.*' || f === 'admin.settings' || f === 'admin.settings.domains');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { domain } = req.body;

  if (!domain) {
    return res.status(400).json({ error: 'Domain is required' });
  }

  try {
    const member = await getSessionMember(req);
    if (!member) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const isAdmin = await isAdministrator(member);
    if (!isAdmin) {
      return res.status(403).json({ error: 'Administrator access required to manage domains' });
    }

    const { data: org } = await supabase
      .from('organization')
      .select('tenant_id')
      .eq('id', member.organization_id)
      .single();

    if (!org?.tenant_id) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const { data: tenant } = await supabase
      .from('tenant')
      .select('domain')
      .eq('id', org.tenant_id)
      .single();

    if (!tenant || tenant.domain !== domain) {
      return res.status(404).json({ error: 'Domain not found for this workspace' });
    }

    if (VERCEL_TOKEN && VERCEL_PROJECT_ID) {
      try {
        const vercelUrl = VERCEL_TEAM_ID 
          ? `https://api.vercel.com/v9/projects/${VERCEL_PROJECT_ID}/domains/${domain}?teamId=${VERCEL_TEAM_ID}`
          : `https://api.vercel.com/v9/projects/${VERCEL_PROJECT_ID}/domains/${domain}`;
        
        const response = await fetch(vercelUrl, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${VERCEL_TOKEN}`,
          },
        });

        if (!response.ok) {
          const vercelResponse = await response.json();
          console.error('[Remove Domain] Vercel API error:', vercelResponse);
        }
      } catch (vercelErr) {
        console.error('[Remove Domain] Vercel API error:', vercelErr);
      }
    }

    const { error: updateError } = await supabase
      .from('tenant')
      .update({ domain: null })
      .eq('id', org.tenant_id);

    if (updateError) {
      console.error('[Remove Domain] Error updating tenant:', updateError);
      return res.status(500).json({ error: 'Failed to remove domain' });
    }

    return res.status(200).json({
      success: true,
      message: 'Domain removed successfully'
    });

  } catch (err) {
    console.error('[Remove Domain] Error:', err);
    return res.status(500).json({ error: 'Failed to remove domain' });
  }
}
